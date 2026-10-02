import { appendFileSync, copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { runCli } from "../src/cli-run.js";
import {
  captureStream,
  expectValidAnswer,
  fixturePath,
  loadLoaded,
  runBuiltCli,
  withEnv,
  withTempDir,
} from "./helpers.js";

const FIXTURE = fixturePath("describe.json");

const USAGE = { input_tokens: 500, output_tokens: 30 };

const happyBody = {
  model: "jev-1.13.0",
  answers: {
    task: {
      type: "choice",
      choice: "task-a",
      confidence: 0.9,
      probabilities: { "task-a": 0.9, "task-b": 0.1 },
    },
    needs_browser: { type: "noul", noul: 0.8 },
    "needs_repo-access": { type: "noul", noul: 0.2 },
  },
  usage: USAGE,
};

interface RunResult {
  exitCode: number;
  stdout: () => string;
  stderr: () => string;
}

async function run(args: string[], stdin?: string): Promise<RunResult> {
  const out = captureStream();
  const err = captureStream();
  const exitCode = await runCli(args, {
    stdout: out.stream,
    stderr: err.stream,
    readStdin: () => {
      if (stdin === undefined) throw new Error("unexpected stdin read");
      return stdin;
    },
  });
  return { exitCode, stdout: out.text, stderr: err.text };
}

async function errorEnvelope(text: () => string): Promise<Record<string, unknown>> {
  const parsed = JSON.parse(text()) as { error: Record<string, unknown> };
  expect(Object.keys(parsed)).toEqual(["error"]);
  return parsed.error;
}

/** Stub the real fetch with a recorded Jev response. */
function stubFetch(body: unknown): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

async function withDescriptionFile(
  text: string,
  fn: (file: string) => Promise<void>,
): Promise<void> {
  await withTempDir(async (dir) => {
    const file = join(dir, "work.txt");
    // writeFileSync is imported through the fs module the CLI reads with.
    const { writeFileSync } = await import("node:fs");
    writeFileSync(file, text);
    await fn(file);
  });
}

describe("--describe privacy refusal", () => {
  test("privacy secret exits 2 with describe-private and makes no request", async () =>
    withEnv({ TYPESAFE_API_KEY: "k-123" }, async () => {
      await withDescriptionFile("some work", async (file) => {
        const fetchSpy = vi.spyOn(globalThis, "fetch");
        const result = await run([
          "--describe",
          file,
          "--registry",
          FIXTURE,
          '{"privacy":"secret"}',
        ]);
        expect(result.exitCode).toBe(2);
        const error = await errorEnvelope(result.stderr);
        expect(error.code).toBe("describe-private");
        expect(error.field).toBe("privacy");
        expect(fetchSpy).not.toHaveBeenCalled();
        fetchSpy.mockRestore();
      });
    }));

  test("no privacy exits 2 with query-invalid on the privacy field and makes no request", async () =>
    withEnv({ TYPESAFE_API_KEY: "k-123" }, async () => {
      await withDescriptionFile("some work", async (file) => {
        const fetchSpy = vi.spyOn(globalThis, "fetch");
        const result = await run(["--describe", file, "--registry", FIXTURE, '{"stakes":"high"}']);
        expect(result.exitCode).toBe(2);
        const error = await errorEnvelope(result.stderr);
        expect(error.code).toBe("query-invalid");
        expect(error.field).toBe("privacy");
        expect(fetchSpy).not.toHaveBeenCalled();
        fetchSpy.mockRestore();
      });
    }));

  test("an empty description file exits 2 with query-invalid and makes no request", async () =>
    withEnv({ TYPESAFE_API_KEY: "k-123" }, async () => {
      await withDescriptionFile("   \n", async (file) => {
        const fetchSpy = vi.spyOn(globalThis, "fetch");
        const result = await run([
          "--describe",
          file,
          "--registry",
          FIXTURE,
          '{"privacy":"normal"}',
        ]);
        expect(result.exitCode).toBe(2);
        const error = await errorEnvelope(result.stderr);
        expect(error.code).toBe("query-invalid");
        expect(fetchSpy).not.toHaveBeenCalled();
        fetchSpy.mockRestore();
      });
    }));

  test("a description file that does not exist exits 2", async () => {
    const result = await run([
      "--describe",
      "/nonexistent/work.txt",
      "--registry",
      FIXTURE,
      '{"privacy":"normal"}',
    ]);
    expect(result.exitCode).toBe(2);
    const error = await errorEnvelope(result.stderr);
    expect(error.code).toBe("query-invalid");
    expect(error.field).toBe("describe");
  });

  test("a secret query exits 2 describe-private before the config loads", async () => {
    const result = await run([
      "--describe",
      "/nonexistent/work.txt",
      "--config",
      "/nonexistent/config.json",
      "--registry",
      FIXTURE,
      '{"privacy":"secret"}',
    ]);
    expect(result.exitCode).toBe(2);
    const error = await errorEnvelope(result.stderr);
    expect(error.code).toBe("describe-private");
  });

  test("a secret query exits 2 describe-private before the description file is read", async () => {
    const result = await run([
      "--describe",
      "/nonexistent/work.txt",
      "--registry",
      FIXTURE,
      '{"privacy":"secret"}',
    ]);
    expect(result.exitCode).toBe(2);
    const error = await errorEnvelope(result.stderr);
    expect(error.code).toBe("describe-private");
  });
});

describe("--describe with a recorded Jev answer", () => {
  test("fills the task, adds needs, and merges the describe block into the answer", async () =>
    withEnv({ TYPESAFE_API_KEY: "k-123" }, async () => {
      await withDescriptionFile("implement the feature", async (file) => {
        const fetchSpy = stubFetch(happyBody);
        const result = await run([
          "--describe",
          file,
          "--registry",
          FIXTURE,
          '{"privacy":"normal"}',
        ]);
        expect(result.exitCode).toBe(0);
        const answer = JSON.parse(result.stdout());
        expectValidAnswer(answer);
        expect(answer.query.task).toBe("task-a");
        expect(answer.query.needs).toEqual(["browser"]);
        expect(answer.describe?.model).toBe("jev-1.13.0");
        expect(answer.describe?.taskGate).toBe(0.85);
        expect(answer.describe?.capabilityThreshold).toBe(0.5);
        expect(answer.describe?.task.candidates).toEqual([
          { task: "task-a", probability: 0.9 },
          { task: "task-b", probability: 0.1 },
        ]);
        expect(answer.describe?.needsAdded).toEqual([{ capability: "browser", probability: 0.8 }]);
        expect(answer.describe?.usage).toEqual(USAGE);
        // The need Jev added is a hard limit: model-b has no browser capability.
        expect(answer.removed.map((entry: { label: string }) => entry.label)).toEqual([
          "model-b@harness-x",
        ]);
        fetchSpy.mockRestore();
      });
    }));

  test("a confidence below taskGate keeps the guess and adds the warning with its fix", async () =>
    withEnv({ TYPESAFE_API_KEY: "k-123" }, async () => {
      await withDescriptionFile("unclear work", async (file) => {
        const body = {
          ...happyBody,
          answers: {
            task: {
              type: "choice",
              choice: "task-b",
              confidence: 0.6,
              probabilities: { "task-a": 0.4, "task-b": 0.6 },
            },
            needs_browser: { type: "noul", noul: 0.1 },
            "needs_repo-access": { type: "noul", noul: 0.1 },
          },
        };
        const fetchSpy = stubFetch(body);
        const result = await run([
          "--describe",
          file,
          "--registry",
          FIXTURE,
          '{"privacy":"normal"}',
        ]);
        expect(result.exitCode).toBe(0);
        const answer = JSON.parse(result.stdout());
        expectValidAnswer(answer);
        expect(answer.query.task).toBe("task-b");
        expect(answer.warnings).toHaveLength(1);
        expect(answer.warnings[0]?.code).toBe("task-uncertain");
        expect(answer.warnings[0]?.fix).toContain("task");
        expect(answer.describe?.task.confidence).toBe(0.6);
        fetchSpy.mockRestore();
      });
    }));

  test("the query can also come from stdin with --describe", async () =>
    withEnv({ TYPESAFE_API_KEY: "k-123" }, async () => {
      await withDescriptionFile("implement the feature", async (file) => {
        const fetchSpy = stubFetch(happyBody);
        const result = await run(
          ["--describe", file, "--registry", FIXTURE, "-"],
          '{"privacy":"normal"}',
        );
        expect(result.exitCode).toBe(0);
        const answer = JSON.parse(result.stdout());
        expectValidAnswer(answer);
        expect(answer.query.task).toBe("task-a");
        fetchSpy.mockRestore();
      });
    }));

  test("--config gates reach the describe step and appear in the block", async () =>
    withEnv({ TYPESAFE_API_KEY: "k-123" }, async () => {
      await withTempDir(async (dir) => {
        const { writeFileSync } = await import("node:fs");
        const file = join(dir, "work.txt");
        writeFileSync(file, "unclear work");
        const configPath = join(dir, "config.json");
        writeFileSync(
          configPath,
          `${JSON.stringify({ describe: { taskGate: 0.5, capabilityThreshold: 0.9 } }, null, 2)}\n`,
        );
        const body = {
          ...happyBody,
          answers: {
            task: {
              type: "choice",
              choice: "task-b",
              confidence: 0.6,
              probabilities: { "task-a": 0.4, "task-b": 0.6 },
            },
            needs_browser: { type: "noul", noul: 0.8 },
            "needs_repo-access": { type: "noul", noul: 0.1 },
          },
        };
        const fetchSpy = stubFetch(body);
        const result = await run([
          "--describe",
          file,
          "--config",
          configPath,
          "--registry",
          FIXTURE,
          '{"privacy":"normal"}',
        ]);
        expect(result.exitCode).toBe(0);
        const answer = JSON.parse(result.stdout());
        expectValidAnswer(answer);
        expect(answer.warnings).toEqual([]);
        expect(answer.describe?.taskGate).toBe(0.5);
        expect(answer.describe?.capabilityThreshold).toBe(0.9);
        expect(answer.describe?.needsAdded).toEqual([]);
        fetchSpy.mockRestore();
      });
    }));
});

describe("--describe failures", () => {
  test("a missing key with the task needed exits 5 with describe-failed naming only the variable", async () =>
    withEnv({ TYPESAFE_API_KEY: undefined }, async () => {
      await withDescriptionFile("some work", async (file) => {
        const result = await run([
          "--describe",
          file,
          "--registry",
          FIXTURE,
          '{"privacy":"normal"}',
        ]);
        expect(result.exitCode).toBe(5);
        const error = await errorEnvelope(result.stderr);
        expect(error.code).toBe("describe-failed");
        expect(error.message).toBe(
          "the describe step needed a task from Jev and the call failed (MISSING_KEY): " +
            "TYPESAFE_API_KEY is not set. Set it in the environment and run the command again.",
        );
      });
    }));

  test("a missing key with nothing to ask still ranks: exit 0, no warning, no request", async () =>
    withEnv({ TYPESAFE_API_KEY: undefined }, async () => {
      await withDescriptionFile("some work", async (file) => {
        const result = await run([
          "--describe",
          file,
          "--registry",
          fixturePath("no-questions.json"),
          '{"privacy":"normal","task":"task-a"}',
        ]);
        expect(result.exitCode).toBe(0);
        const answer = JSON.parse(result.stdout());
        expectValidAnswer(answer);
        expect(answer.describe?.model).toBeNull();
        expect(answer.warnings).toEqual([]);
        expect(answer.query.task).toBe("task-a");
      });
    }));

  test("a missing key with a caller task ranks anyway and warns capabilities-unasked", async () =>
    withEnv({ TYPESAFE_API_KEY: undefined }, async () => {
      await withDescriptionFile("some work", async (file) => {
        const result = await run([
          "--describe",
          file,
          "--registry",
          FIXTURE,
          '{"privacy":"normal","task":"task-a"}',
        ]);
        expect(result.exitCode).toBe(0);
        const answer = JSON.parse(result.stdout());
        expectValidAnswer(answer);
        expect(answer.describe?.model).toBeNull();
        expect(answer.warnings.map((warning: { code: string }) => warning.code)).toEqual([
          "capabilities-unasked",
        ]);
      });
    }));

  test("the built CLI exits 5 too", async () => {
    await withTempDir(async (dir) => {
      const { writeFileSync } = await import("node:fs");
      const file = join(dir, "work.txt");
      writeFileSync(file, "some work");
      const result = runBuiltCli(
        ["--describe", file, "--registry", FIXTURE, '{"privacy":"normal"}'],
        { TYPESAFE_API_KEY: undefined },
      );
      expect(result.exitCode).toBe(5);
      const parsed = JSON.parse(result.stderr) as { error: { code: string; message: string } };
      expect(parsed.error.code).toBe("describe-failed");
      expect(parsed.error.message).toContain("TYPESAFE_API_KEY");
    });
  });

  test("a choice answer without probabilities exits 5, not 1", async () =>
    withEnv({ TYPESAFE_API_KEY: "k-123" }, async () => {
      await withDescriptionFile("some work", async (file) => {
        const body = {
          model: "jev-1.13.0",
          answers: {
            task: { type: "choice", choice: "task-a", confidence: 0.9 },
            needs_browser: { type: "noul", noul: 0.8 },
            "needs_repo-access": { type: "noul", noul: 0.2 },
          },
          usage: USAGE,
        };
        const fetchSpy = stubFetch(body);
        const result = await run([
          "--describe",
          file,
          "--registry",
          FIXTURE,
          '{"privacy":"normal"}',
        ]);
        expect(result.exitCode).toBe(5);
        const error = await errorEnvelope(result.stderr);
        expect(error.code).toBe("describe-failed");
        expect(error.message).toContain("BAD_RESPONSE");
        fetchSpy.mockRestore();
      });
    }));

  test("a service failure with the task needed exits 5 carrying the code", async () =>
    withEnv({ TYPESAFE_API_KEY: "k-123" }, async () => {
      await withDescriptionFile("some work", async (file) => {
        const fetchSpy = vi
          .spyOn(globalThis, "fetch")
          .mockResolvedValue(new Response("upstream said no", { status: 400 }));
        const result = await run([
          "--describe",
          file,
          "--registry",
          FIXTURE,
          '{"privacy":"normal"}',
        ]);
        expect(result.exitCode).toBe(5);
        const error = await errorEnvelope(result.stderr);
        expect(error.code).toBe("describe-failed");
        expect(error.message).toContain("SERVICE_ERROR");
        fetchSpy.mockRestore();
      });
    }));
});

describe("--describe flag handling", () => {
  test("--describe given twice exits 2", async () => {
    await withDescriptionFile("some work", async (file) => {
      const result = await run([
        "--describe",
        file,
        "--describe",
        file,
        "--registry",
        FIXTURE,
        '{"privacy":"normal"}',
      ]);
      expect(result.exitCode).toBe(2);
      const error = await errorEnvelope(result.stderr);
      expect(error.code).toBe("query-invalid");
    });
  });

  test("--describe with an empty path exits 2", async () => {
    const result = await run(["--describe", "", "--registry", FIXTURE, '{"privacy":"normal"}']);
    expect(result.exitCode).toBe(2);
    const error = await errorEnvelope(result.stderr);
    expect(error.code).toBe("query-invalid");
    expect(error.field).toBe("describe");
  });

  test("--describe does not apply to tasks and exits 2", async () => {
    await withDescriptionFile("some work", async (file) => {
      const result = await run(["tasks", "--describe", file, "--registry", FIXTURE]);
      expect(result.exitCode).toBe(2);
      const error = await errorEnvelope(result.stderr);
      expect(error.code).toBe("query-invalid");
    });
  });

  test("--describe does not apply to check and exits 2", async () => {
    await withDescriptionFile("some work", async (file) => {
      const result = await run(["check", "--describe", file, "--registry", FIXTURE]);
      expect(result.exitCode).toBe(2);
      const error = await errorEnvelope(result.stderr);
      expect(error.code).toBe("query-invalid");
    });
  });

  test("an answer with no route still prints and exits 3 under --describe", async () =>
    withEnv({ TYPESAFE_API_KEY: "k-123" }, async () => {
      await withDescriptionFile("some work", async (file) => {
        const fetchSpy = stubFetch(happyBody);
        const result = await run([
          "--describe",
          file,
          "--registry",
          FIXTURE,
          '{"privacy":"normal","excludeFamilies":["family-a","family-b"]}',
        ]);
        expect(result.exitCode).toBe(3);
        const answer = JSON.parse(result.stdout());
        expectValidAnswer(answer);
        expect(answer.routes).toEqual([]);
        expect(answer.describe?.model).toBe("jev-1.13.0");
        fetchSpy.mockRestore();
      });
    }));
});

describe("--describe help", () => {
  test("the --describe entry carries no collector default and the exit help names describe-private", async () => {
    const result = await run(["--help"]);
    expect(result.exitCode).toBe(0);
    const describeLine = result
      .stdout()
      .split("\n")
      .find((line) => line.includes("--describe <file>"));
    expect(describeLine).toBeDefined();
    expect(describeLine).not.toContain("(default:");
    expect(result.stdout()).toContain("describe-private");
  });
});

describe("without --describe nothing changes", () => {
  test("a rank call with no key set still succeeds: no Jev call is made", async () =>
    withEnv({ TYPESAFE_API_KEY: undefined }, async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      const result = await run(["--registry", FIXTURE, '{"task":"task-a","privacy":"normal"}']);
      expect(result.exitCode).toBe(0);
      expect(fetchSpy).not.toHaveBeenCalled();
      const answer = JSON.parse(result.stdout());
      expect(answer.describe).toBeNull();
      fetchSpy.mockRestore();
    }));

  test("the fixture on disk still parses as the tests assume", () => {
    const raw = JSON.parse(readFileSync(FIXTURE, "utf8")) as {
      router: { questions: Record<string, string> };
    };
    expect(Object.keys(raw.router.questions).sort()).toEqual(["browser", "repo-access"]);
  });
});

describe("--describe registry loading", () => {
  test("the registry is loaded once: a rewrite during the Jev call leaves the digest at the original bytes", async () =>
    withEnv({ TYPESAFE_API_KEY: "k-123" }, async () => {
      await withTempDir(async (dir) => {
        const registryCopy = join(dir, "registry.json");
        copyFileSync(FIXTURE, registryCopy);
        const original = loadLoaded(registryCopy);
        const file = join(dir, "work.txt");
        writeFileSync(file, "some work");
        const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
          // Rewrite the registry while the Jev answer is being built: the
          // answer must still carry the digest of the bytes that were
          // loaded before the call.
          appendFileSync(registryCopy, "\n");
          return new Response(JSON.stringify(happyBody), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        });
        const result = await run([
          "--describe",
          file,
          "--registry",
          registryCopy,
          '{"privacy":"normal"}',
        ]);
        expect(result.exitCode).toBe(0);
        const answer = JSON.parse(result.stdout());
        expectValidAnswer(answer);
        expect(answer.registryDigest).toBe(original.digest);
        fetchSpy.mockRestore();
      });
    }));
});

describe("--describe warning order", () => {
  test("the describe warnings come before the ranking warnings", async () =>
    withEnv({ TYPESAFE_API_KEY: "k-123" }, async () => {
      await withDescriptionFile("unclear work", async (file) => {
        const body = {
          ...happyBody,
          answers: {
            task: {
              type: "choice",
              choice: "task-b",
              confidence: 0.6,
              probabilities: { "task-a": 0.4, "task-b": 0.6 },
            },
            needs_browser: { type: "noul", noul: 0.1 },
            "needs_repo-access": { type: "noul", noul: 0.1 },
          },
        };
        const fetchSpy = stubFetch(body);
        // family-c is unknown, so rank warns family-unknown beside the
        // describe step's task-uncertain.
        const result = await run([
          "--describe",
          file,
          "--registry",
          FIXTURE,
          '{"privacy":"normal","excludeFamilies":["family-c"]}',
        ]);
        expect(result.exitCode).toBe(0);
        const answer = JSON.parse(result.stdout());
        expectValidAnswer(answer);
        expect(answer.warnings.map((warning: { code: string }) => warning.code)).toEqual([
          "task-uncertain",
          "family-unknown",
        ]);
        fetchSpy.mockRestore();
      });
    }));
});
