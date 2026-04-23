// Package main implements a lightweight HTTP executor for running commands
// inside cloud-managed containers (Azure Container Apps, AWS Bedrock
// AgentCore, GCP Vertex Agent Engine).
//
// Endpoints:
//   GET  /ping         — health check
//   POST /exec         — one-shot command execution
//   POST /exec/stream  — streaming command execution (SSE)
//   POST /fs/put       — write a file into the container
//   POST /invocations  — AWS AgentCore compatibility wrapper
//
// Auth: Bearer token from EXECUTOR_TOKEN env var (mandatory).
// Port: EXECUTOR_PORT env var (default 8080).
package main

import (
	"bufio"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

var token string

func main() {
	token = os.Getenv("EXECUTOR_TOKEN")
	if token == "" {
		log.Fatal("EXECUTOR_TOKEN env var is required")
	}

	port := os.Getenv("EXECUTOR_PORT")
	if port == "" {
		port = "8080"
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /ping", handlePing)
	mux.HandleFunc("POST /exec", requireAuth(handleExec))
	mux.HandleFunc("POST /exec/stream", requireAuth(handleExecStream))
	mux.HandleFunc("POST /fs/put", requireAuth(handleFsPut))
	mux.HandleFunc("POST /invocations", requireAuth(handleInvocations)) // AWS AgentCore compat

	log.Printf("[executor] listening on :%s", port)
	if err := http.ListenAndServe(":"+port, mux); err != nil {
		log.Fatalf("server error: %v", err)
	}
}

// ── Auth middleware ─────────────────────────────────────────────────────

func requireAuth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		auth := r.Header.Get("Authorization")
		if auth == "" || !strings.HasPrefix(auth, "Bearer ") {
			http.Error(w, `{"error":"missing or invalid Authorization header"}`, http.StatusUnauthorized)
			return
		}
		if strings.TrimPrefix(auth, "Bearer ") != token {
			http.Error(w, `{"error":"invalid token"}`, http.StatusForbidden)
			return
		}
		next(w, r)
	}
}

// ── GET /ping ───────────────────────────────────────────────────────────

func handlePing(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("X-Executor-API", "1")
	fmt.Fprint(w, `{"status":"healthy"}`)
}

// ── POST /exec ──────────────────────────────────────────────────────────

type execRequest struct {
	Argv      []string `json:"argv"`
	Stdin     string   `json:"stdin,omitempty"`
	TimeoutMs int      `json:"timeout_ms,omitempty"`
}

type execResponse struct {
	Stdout   string `json:"stdout"`
	Stderr   string `json:"stderr"`
	ExitCode int    `json:"exit_code"`
}

func handleExec(w http.ResponseWriter, r *http.Request) {
	var req execRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid JSON body"}`, http.StatusBadRequest)
		return
	}
	if len(req.Argv) == 0 {
		http.Error(w, `{"error":"argv is required"}`, http.StatusBadRequest)
		return
	}

	timeout := 120 * time.Second
	if req.TimeoutMs > 0 {
		timeout = time.Duration(req.TimeoutMs) * time.Millisecond
	}

	cmd := exec.Command(req.Argv[0], req.Argv[1:]...)
	if req.Stdin != "" {
		cmd.Stdin = strings.NewReader(req.Stdin)
	}

	var stdout, stderr strings.Builder
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	done := make(chan error, 1)
	go func() { done <- cmd.Run() }()

	select {
	case err := <-done:
		exitCode := 0
		if err != nil {
			if exitErr, ok := err.(*exec.ExitError); ok {
				exitCode = exitErr.ExitCode()
			} else {
				exitCode = -1
			}
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(execResponse{
			Stdout:   stdout.String(),
			Stderr:   stderr.String(),
			ExitCode: exitCode,
		})

	case <-time.After(timeout):
		if cmd.Process != nil {
			cmd.Process.Kill()
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusGatewayTimeout)
		json.NewEncoder(w).Encode(execResponse{
			Stderr:   "executor: command timed out",
			ExitCode: -1,
		})
	}
}

// ── POST /exec/stream ───────────────────────────────────────────────────

func handleExecStream(w http.ResponseWriter, r *http.Request) {
	var req execRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid JSON body"}`, http.StatusBadRequest)
		return
	}
	if len(req.Argv) == 0 {
		http.Error(w, `{"error":"argv is required"}`, http.StatusBadRequest)
		return
	}

	cmd := exec.Command(req.Argv[0], req.Argv[1:]...)
	if req.Stdin != "" {
		cmd.Stdin = strings.NewReader(req.Stdin)
	}

	stdoutPipe, err := cmd.StdoutPipe()
	if err != nil {
		http.Error(w, fmt.Sprintf(`{"error":"stdout pipe: %s"}`, err), http.StatusInternalServerError)
		return
	}
	stderrPipe, err := cmd.StderrPipe()
	if err != nil {
		http.Error(w, fmt.Sprintf(`{"error":"stderr pipe: %s"}`, err), http.StatusInternalServerError)
		return
	}

	if err := cmd.Start(); err != nil {
		http.Error(w, fmt.Sprintf(`{"error":"start: %s"}`, err), http.StatusInternalServerError)
		return
	}

	// SSE headers
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	w.Header().Set("X-Executor-API", "1")
	w.WriteHeader(http.StatusOK)

	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, `{"error":"streaming not supported"}`, http.StatusInternalServerError)
		return
	}

	// Stream stdout as base64-encoded SSE events
	go func() {
		scanner := bufio.NewScanner(stderrPipe)
		scanner.Buffer(make([]byte, 1024*1024), 1024*1024)
		for scanner.Scan() {
			// Stderr is captured but not streamed — collected for the exit event
		}
	}()

	scanner := bufio.NewScanner(stdoutPipe)
	scanner.Buffer(make([]byte, 1024*1024), 1024*1024) // 1MB line buffer
	for scanner.Scan() {
		chunk := scanner.Bytes()
		encoded := base64.StdEncoding.EncodeToString(chunk)
		fmt.Fprintf(w, "event: stdout\ndata: %s\n\n", encoded)
		flusher.Flush()
	}

	exitCode := 0
	if err := cmd.Wait(); err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			exitCode = exitErr.ExitCode()
		} else {
			exitCode = -1
		}
	}

	// Final exit event
	fmt.Fprintf(w, "event: exit\ndata: {\"exit_code\":%d}\n\n", exitCode)
	flusher.Flush()
}

// ── POST /fs/put ────────────────────────────────────────────────────────

type fsPutRequest struct {
	Path            string `json:"path"`
	Content         string `json:"content"`
	ContentEncoding string `json:"content_encoding,omitempty"` // "base64" or empty (plain text)
	Mode            int    `json:"mode,omitempty"`             // file permissions (default 0644)
}

func handleFsPut(w http.ResponseWriter, r *http.Request) {
	var req fsPutRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid JSON body"}`, http.StatusBadRequest)
		return
	}
	if req.Path == "" {
		http.Error(w, `{"error":"path is required"}`, http.StatusBadRequest)
		return
	}
	// Security: reject path traversal
	if strings.Contains(req.Path, "..") {
		http.Error(w, `{"error":"path traversal not allowed"}`, http.StatusBadRequest)
		return
	}

	// Ensure parent directory exists
	dir := filepath.Dir(req.Path)
	if err := os.MkdirAll(dir, 0755); err != nil {
		http.Error(w, fmt.Sprintf(`{"error":"mkdir: %s"}`, err), http.StatusInternalServerError)
		return
	}

	var data []byte
	if req.ContentEncoding == "base64" {
		var err error
		data, err = base64.StdEncoding.DecodeString(req.Content)
		if err != nil {
			http.Error(w, fmt.Sprintf(`{"error":"base64 decode: %s"}`, err), http.StatusBadRequest)
			return
		}
	} else {
		data = []byte(req.Content)
	}

	mode := os.FileMode(0644)
	if req.Mode > 0 {
		mode = os.FileMode(req.Mode)
	}

	if err := os.WriteFile(req.Path, data, mode); err != nil {
		http.Error(w, fmt.Sprintf(`{"error":"write: %s"}`, err), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"path": req.Path,
		"size": len(data),
		"ok":   true,
	})
}

// ── POST /invocations (AWS AgentCore compat) ────────────────────────────

func handleInvocations(w http.ResponseWriter, r *http.Request) {
	// AgentCore sends { input: { prompt: "..." } }
	// We treat it as an exec of the default shell with the prompt as stdin
	var body struct {
		Input struct {
			Argv  []string `json:"argv,omitempty"`
			Stdin string   `json:"stdin,omitempty"`
		} `json:"input"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, `{"error":"invalid JSON body"}`, http.StatusBadRequest)
		return
	}

	argv := body.Input.Argv
	if len(argv) == 0 {
		argv = []string{"sh", "-c", "echo ok"}
	}

	cmd := exec.Command(argv[0], argv[1:]...)
	if body.Input.Stdin != "" {
		cmd.Stdin = strings.NewReader(body.Input.Stdin)
	}

	var stdout, stderr strings.Builder
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	exitCode := 0
	if err := cmd.Run(); err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			exitCode = exitErr.ExitCode()
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"output": map[string]interface{}{
			"stdout":    stdout.String(),
			"stderr":    stderr.String(),
			"exit_code": exitCode,
		},
	})
}
