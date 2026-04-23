package main

import (
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func init() {
	token = "test-token"
}

func authHeader() http.Header {
	h := http.Header{}
	h.Set("Authorization", "Bearer test-token")
	h.Set("Content-Type", "application/json")
	return h
}

// ── /ping ───────────────────────────────────────────────────────────────

func TestPing(t *testing.T) {
	req := httptest.NewRequest("GET", "/ping", nil)
	w := httptest.NewRecorder()
	handlePing(w, req)

	if w.Code != 200 {
		t.Fatalf("expected 200, got %d", w.Code)
	}
	if !strings.Contains(w.Body.String(), "healthy") {
		t.Fatalf("expected healthy, got %s", w.Body.String())
	}
	if w.Header().Get("X-Executor-API") != "1" {
		t.Fatal("missing X-Executor-API header")
	}
}

// ── Auth ────────────────────────────────────────────────────────────────

func TestAuthRequired(t *testing.T) {
	handler := requireAuth(handleExec)

	// No auth header
	req := httptest.NewRequest("POST", "/exec", strings.NewReader(`{"argv":["echo","hi"]}`))
	w := httptest.NewRecorder()
	handler(w, req)
	if w.Code != 401 {
		t.Fatalf("expected 401, got %d", w.Code)
	}

	// Wrong token
	req = httptest.NewRequest("POST", "/exec", strings.NewReader(`{"argv":["echo","hi"]}`))
	req.Header.Set("Authorization", "Bearer wrong")
	w = httptest.NewRecorder()
	handler(w, req)
	if w.Code != 403 {
		t.Fatalf("expected 403, got %d", w.Code)
	}

	// Correct token
	req = httptest.NewRequest("POST", "/exec", strings.NewReader(`{"argv":["echo","hi"]}`))
	req.Header.Set("Authorization", "Bearer test-token")
	w = httptest.NewRecorder()
	handler(w, req)
	if w.Code != 200 {
		t.Fatalf("expected 200, got %d", w.Code)
	}
}

// ── /exec ───────────────────────────────────────────────────────────────

func TestExecEcho(t *testing.T) {
	body := `{"argv":["echo","hello world"]}`
	req := httptest.NewRequest("POST", "/exec", strings.NewReader(body))
	req.Header = authHeader()
	w := httptest.NewRecorder()
	requireAuth(handleExec)(w, req)

	if w.Code != 200 {
		t.Fatalf("expected 200, got %d", w.Code)
	}

	var resp execResponse
	json.Unmarshal(w.Body.Bytes(), &resp)
	if strings.TrimSpace(resp.Stdout) != "hello world" {
		t.Fatalf("expected 'hello world', got %q", resp.Stdout)
	}
	if resp.ExitCode != 0 {
		t.Fatalf("expected exit 0, got %d", resp.ExitCode)
	}
}

func TestExecStdin(t *testing.T) {
	body := `{"argv":["cat"],"stdin":"from stdin"}`
	req := httptest.NewRequest("POST", "/exec", strings.NewReader(body))
	req.Header = authHeader()
	w := httptest.NewRecorder()
	requireAuth(handleExec)(w, req)

	var resp execResponse
	json.Unmarshal(w.Body.Bytes(), &resp)
	if resp.Stdout != "from stdin" {
		t.Fatalf("expected 'from stdin', got %q", resp.Stdout)
	}
}

func TestExecNonZeroExit(t *testing.T) {
	body := `{"argv":["sh","-c","exit 42"]}`
	req := httptest.NewRequest("POST", "/exec", strings.NewReader(body))
	req.Header = authHeader()
	w := httptest.NewRecorder()
	requireAuth(handleExec)(w, req)

	var resp execResponse
	json.Unmarshal(w.Body.Bytes(), &resp)
	if resp.ExitCode != 42 {
		t.Fatalf("expected exit 42, got %d", resp.ExitCode)
	}
}

func TestExecEmptyArgv(t *testing.T) {
	body := `{"argv":[]}`
	req := httptest.NewRequest("POST", "/exec", strings.NewReader(body))
	req.Header = authHeader()
	w := httptest.NewRecorder()
	requireAuth(handleExec)(w, req)

	if w.Code != 400 {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}

// ── /exec/stream ────────────────────────────────────────────────────────

func TestExecStream(t *testing.T) {
	body := `{"argv":["sh","-c","echo line1; echo line2"]}`
	req := httptest.NewRequest("POST", "/exec/stream", strings.NewReader(body))
	req.Header = authHeader()
	w := httptest.NewRecorder()
	requireAuth(handleExecStream)(w, req)

	if w.Code != 200 {
		t.Fatalf("expected 200, got %d", w.Code)
	}
	if !strings.Contains(w.Header().Get("Content-Type"), "text/event-stream") {
		t.Fatal("expected text/event-stream content type")
	}

	// Parse SSE events
	events := strings.Split(w.Body.String(), "\n\n")
	stdoutCount := 0
	hasExit := false
	for _, event := range events {
		if strings.Contains(event, "event: stdout") {
			stdoutCount++
			// Extract data line and verify base64
			for _, line := range strings.Split(event, "\n") {
				if strings.HasPrefix(line, "data: ") {
					data := strings.TrimPrefix(line, "data: ")
					decoded, err := base64.StdEncoding.DecodeString(data)
					if err != nil {
						t.Fatalf("invalid base64: %v", err)
					}
					if len(decoded) == 0 {
						t.Fatal("empty decoded data")
					}
				}
			}
		}
		if strings.Contains(event, "event: exit") {
			hasExit = true
		}
	}
	if stdoutCount < 2 {
		t.Fatalf("expected at least 2 stdout events, got %d", stdoutCount)
	}
	if !hasExit {
		t.Fatal("missing exit event")
	}
}

// ── /fs/put ─────────────────────────────────────────────────────────────

func TestFsPut(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "sub", "test.txt")

	body, _ := json.Marshal(fsPutRequest{
		Path:    target,
		Content: "hello file",
	})
	req := httptest.NewRequest("POST", "/fs/put", strings.NewReader(string(body)))
	req.Header = authHeader()
	w := httptest.NewRecorder()
	requireAuth(handleFsPut)(w, req)

	if w.Code != 200 {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	data, err := os.ReadFile(target)
	if err != nil {
		t.Fatalf("file not created: %v", err)
	}
	if string(data) != "hello file" {
		t.Fatalf("expected 'hello file', got %q", string(data))
	}
}

func TestFsPutBase64(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "binary.dat")
	original := []byte{0x00, 0x01, 0xFF, 0xFE}

	body, _ := json.Marshal(fsPutRequest{
		Path:            target,
		Content:         base64.StdEncoding.EncodeToString(original),
		ContentEncoding: "base64",
	})
	req := httptest.NewRequest("POST", "/fs/put", strings.NewReader(string(body)))
	req.Header = authHeader()
	w := httptest.NewRecorder()
	requireAuth(handleFsPut)(w, req)

	data, _ := os.ReadFile(target)
	if string(data) != string(original) {
		t.Fatal("binary content mismatch")
	}
}

func TestFsPutRejectsTraversal(t *testing.T) {
	body := `{"path":"/tmp/../etc/passwd","content":"hacked"}`
	req := httptest.NewRequest("POST", "/fs/put", strings.NewReader(body))
	req.Header = authHeader()
	w := httptest.NewRecorder()
	requireAuth(handleFsPut)(w, req)

	if w.Code != 400 {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}

// ── /invocations ────────────────────────────────────────────────────────

func TestInvocations(t *testing.T) {
	body := `{"input":{"argv":["echo","agentcore"],"stdin":""}}`
	req := httptest.NewRequest("POST", "/invocations", strings.NewReader(body))
	req.Header = authHeader()
	w := httptest.NewRecorder()
	requireAuth(handleInvocations)(w, req)

	if w.Code != 200 {
		t.Fatalf("expected 200, got %d", w.Code)
	}

	var resp map[string]interface{}
	json.NewDecoder(w.Body).Decode(&resp)
	output := resp["output"].(map[string]interface{})
	stdout := output["stdout"].(string)
	if strings.TrimSpace(stdout) != "agentcore" {
		t.Fatalf("expected 'agentcore', got %q", stdout)
	}
}

// ── Integration: full server ────────────────────────────────────────────

func TestFullServer(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /ping", handlePing)
	mux.HandleFunc("POST /exec", requireAuth(handleExec))
	mux.HandleFunc("POST /fs/put", requireAuth(handleFsPut))

	ts := httptest.NewServer(mux)
	defer ts.Close()

	// Ping (no auth needed)
	resp, err := http.Get(ts.URL + "/ping")
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != 200 {
		t.Fatalf("ping: expected 200, got %d", resp.StatusCode)
	}

	// Exec with auth
	client := &http.Client{}
	req, _ := http.NewRequest("POST", ts.URL+"/exec", strings.NewReader(`{"argv":["echo","server test"]}`))
	req.Header.Set("Authorization", "Bearer test-token")
	req.Header.Set("Content-Type", "application/json")
	resp, err = client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	var execResp execResponse
	json.Unmarshal(body, &execResp)
	if strings.TrimSpace(execResp.Stdout) != "server test" {
		t.Fatalf("expected 'server test', got %q", execResp.Stdout)
	}
}
