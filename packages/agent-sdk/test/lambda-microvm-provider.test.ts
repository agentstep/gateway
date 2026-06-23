/**
 * Tests for the AWS Lambda MicroVM provider.
 *
 * Mocks the control-plane (SigV4-signed) and data-plane (per-microVM
 * HTTPS endpoint) HTTP calls to verify the provider translates
 * ContainerProvider calls correctly and signs requests.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const originalFetch = globalThis.fetch;
let fetchMock: ReturnType<typeof vi.fn>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  process.env.AWS_ACCESS_KEY_ID = "AKIAEXAMPLE";
  process.env.AWS_SECRET_ACCESS_KEY = "secret-key";
  process.env.AWS_REGION = "us-east-1";
  process.env.LAMBDA_MICROVM_SNAPSHOT = "snap-123";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.AWS_ACCESS_KEY_ID;
  delete process.env.AWS_SECRET_ACCESS_KEY;
  delete process.env.AWS_SESSION_TOKEN;
  delete process.env.AWS_REGION;
  delete process.env.LAMBDA_MICROVM_SNAPSHOT;
  delete process.env.LAMBDA_MICROVM_ENDPOINT;
});

describe("AWS Lambda MicroVM provider", () => {
  it("checkAvailability requires AWS credentials", async () => {
    delete process.env.AWS_ACCESS_KEY_ID;
    const { lambdaMicroVmProvider } = await import("../src/providers/lambda-microvm");
    const result = await lambdaMicroVmProvider.checkAvailability!();
    expect(result.available).toBe(false);
    expect(result.message).toContain("AWS_ACCESS_KEY_ID");
  });

  it("checkAvailability requires a snapshot", async () => {
    delete process.env.LAMBDA_MICROVM_SNAPSHOT;
    const { lambdaMicroVmProvider } = await import("../src/providers/lambda-microvm");
    const result = await lambdaMicroVmProvider.checkAvailability!();
    expect(result.available).toBe(false);
    expect(result.message).toContain("LAMBDA_MICROVM_SNAPSHOT");
  });

  it("checkAvailability returns true when configured", async () => {
    const { lambdaMicroVmProvider } = await import("../src/providers/lambda-microvm");
    const result = await lambdaMicroVmProvider.checkAvailability!();
    expect(result.available).toBe(true);
  });

  it("create calls RunMicroVM with a SigV4-signed request", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ microVmId: "mvm-1", endpoint: "https://mvm-1.lambda-url.aws", authToken: "tok-1" }),
    );
    const { lambdaMicroVmProvider } = await import("../src/providers/lambda-microvm");
    await lambdaMicroVmProvider.create({ name: "ca-sess-aws-1" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://lambda.us-east-1.amazonaws.com/2026-06-30/microvms");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE\//);
    expect(init.headers["x-amz-date"]).toMatch(/^\d{8}T\d{6}Z$/);
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ name: "ca-sess-aws-1", snapshotId: "snap-123" });
  });

  it("create throws when the response lacks an endpoint", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ microVmId: "mvm-1" }));
    const { lambdaMicroVmProvider } = await import("../src/providers/lambda-microvm");
    await expect(lambdaMicroVmProvider.create({ name: "ca-sess-aws-2" })).rejects.toThrow(/endpoint/);
  });

  it("exec posts to the microVM data-plane endpoint with a bearer token", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ microVmId: "mvm-3", endpoint: "https://mvm-3.lambda-url.aws", authToken: "tok-3" }),
    );
    fetchMock.mockResolvedValueOnce(jsonResponse({ stdout: "hi\n", stderr: "", exit_code: 0 }));

    const { lambdaMicroVmProvider } = await import("../src/providers/lambda-microvm");
    await lambdaMicroVmProvider.create({ name: "ca-sess-aws-3" });
    const result = await lambdaMicroVmProvider.exec("ca-sess-aws-3", ["echo", "hi"], { stdin: "x", timeoutMs: 5000 });

    expect(result.stdout).toBe("hi\n");
    expect(result.exit_code).toBe(0);

    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe("https://mvm-3.lambda-url.aws/exec");
    expect(init.headers.Authorization).toBe("Bearer tok-3");
    const body = JSON.parse(init.body);
    expect(body.argv).toEqual(["echo", "hi"]);
    expect(body.stdin).toBe("x");
  });

  it("delete calls TerminateMicroVM", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ microVmId: "mvm-4", endpoint: "https://mvm-4.lambda-url.aws" }),
    );
    fetchMock.mockResolvedValueOnce(jsonResponse({}));

    const { lambdaMicroVmProvider } = await import("../src/providers/lambda-microvm");
    await lambdaMicroVmProvider.create({ name: "ca-sess-aws-4" });
    await lambdaMicroVmProvider.delete("ca-sess-aws-4");

    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe("https://lambda.us-east-1.amazonaws.com/2026-06-30/microvms/mvm-4");
    expect(init.method).toBe("DELETE");
  });

  it("delete is best-effort and does not throw", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ microVmId: "mvm-5", endpoint: "https://mvm-5.lambda-url.aws" }),
    );
    fetchMock.mockRejectedValueOnce(new Error("gone"));
    const { lambdaMicroVmProvider } = await import("../src/providers/lambda-microvm");
    await lambdaMicroVmProvider.create({ name: "ca-sess-aws-5" });
    await expect(lambdaMicroVmProvider.delete("ca-sess-aws-5")).resolves.toBeUndefined();
  });

  it("honors a custom control-plane endpoint", async () => {
    process.env.LAMBDA_MICROVM_ENDPOINT = "https://microvm.example.com";
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ microVmId: "mvm-6", endpoint: "https://mvm-6.example.com" }),
    );
    const { lambdaMicroVmProvider } = await import("../src/providers/lambda-microvm");
    await lambdaMicroVmProvider.create({ name: "ca-sess-aws-6" });
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe("https://microvm.example.com/2026-06-30/microvms");
  });

  it("list filters by prefix and caches discovered microVMs", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        microVms: [
          { microVmId: "a", name: "ca-sess-x", endpoint: "https://a.aws" },
          { microVmId: "b", name: "other", endpoint: "https://b.aws" },
        ],
      }),
    );
    const { lambdaMicroVmProvider } = await import("../src/providers/lambda-microvm");
    const result = await lambdaMicroVmProvider.list({ prefix: "ca-sess-" });
    expect(result).toEqual([{ name: "ca-sess-x" }]);
  });
});
