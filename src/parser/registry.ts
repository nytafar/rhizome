import type { RhizomeConfig } from "../config/schema";
import type { MarkdownProvider, ParserProviderId } from "./types";

export interface ParserRegistryOptions {
  activeProviderId: ParserProviderId;
  providers?: Iterable<MarkdownProvider>;
}

function buildMissingProviderMessage(
  providerId: ParserProviderId,
  providers: ReadonlyMap<string, MarkdownProvider>,
): string {
  const registered = Array.from(providers.keys()).sort();
  const registeredText = registered.length > 0 ? registered.join(", ") : "none";
  return `Parser provider '${providerId}' is not registered. Registered providers: ${registeredText}.`;
}

export class ParserRegistry {
  private readonly providers = new Map<string, MarkdownProvider>();
  private readonly activeProviderId: ParserProviderId;

  public constructor(options: ParserRegistryOptions) {
    this.activeProviderId = options.activeProviderId;

    for (const provider of options.providers ?? []) {
      this.register(provider);
    }
  }

  public static fromConfig(
    config: Pick<RhizomeConfig, "parser">,
    providers?: Iterable<MarkdownProvider>,
  ): ParserRegistry {
    return new ParserRegistry({
      activeProviderId: config.parser.active_provider,
      providers,
    });
  }

  public register(provider: MarkdownProvider): void {
    if (this.providers.has(provider.id)) {
      throw new Error(`Parser provider '${provider.id}' is already registered.`);
    }

    this.providers.set(provider.id, provider);
  }

  public get(providerId: ParserProviderId): MarkdownProvider {
    const provider = this.providers.get(providerId);

    if (!provider) {
      throw new Error(buildMissingProviderMessage(providerId, this.providers));
    }

    return provider;
  }

  public getActive(): MarkdownProvider {
    return this.get(this.activeProviderId);
  }

  public listRegisteredProviderIds(): ParserProviderId[] {
    return Array.from(this.providers.keys()).sort() as ParserProviderId[];
  }
}
