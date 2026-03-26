import { describe, expect, test } from "bun:test";
import { PipelineStep } from "../../types/pipeline";
import { ParserRegistry } from "../registry";
import type { MarkdownProvider, ParseResult } from "../types";

function createProvider(id: MarkdownProvider["id"], name = `Provider ${id}`): MarkdownProvider {
  return {
    id,
    name,
    async parse(): Promise<ParseResult> {
      return {
        markdownPath: `/tmp/${id}.md`,
        metadata: {
          stage: PipelineStep.FULLTEXT_MARKER,
          pageCount: 1,
          provider: id,
          providerVersion: "1.0.0",
          parsedAt: "2026-01-01T00:00:00.000Z",
          hasImages: false,
          hasTables: false,
        },
      };
    },
    async healthcheck() {
      return true;
    },
  };
}

describe("ParserRegistry", () => {
  test("resolves the active provider by configured parser id", () => {
    const markerProvider = createProvider("marker", "Marker PDF");

    const registry = ParserRegistry.fromConfig(
      {
        parser: {
          active_provider: "marker",
        },
      },
      [markerProvider],
    );

    expect(registry.getActive()).toBe(markerProvider);
    expect(registry.listRegisteredProviderIds()).toEqual(["marker"]);
  });

  test("throws deterministic diagnostics when active provider is missing", () => {
    const registry = new ParserRegistry({
      activeProviderId: "marker",
      providers: [createProvider("docling")],
    });

    expect(() => registry.getActive()).toThrow(
      "Parser provider 'marker' is not registered. Registered providers: docling.",
    );
  });

  test("throws deterministic diagnostics when no providers are registered", () => {
    const registry = new ParserRegistry({
      activeProviderId: "marker",
    });

    expect(() => registry.get("marker")).toThrow(
      "Parser provider 'marker' is not registered. Registered providers: none.",
    );
  });

  test("rejects duplicate provider registration", () => {
    const registry = new ParserRegistry({
      activeProviderId: "marker",
    });

    registry.register(createProvider("marker"));

    expect(() => registry.register(createProvider("marker"))).toThrow(
      "Parser provider 'marker' is already registered.",
    );
  });
});
