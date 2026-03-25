import { z } from "zod";

export const CURRENT_CONFIG_VERSION = 1;

const AiWindowSchema = z
  .string()
  .regex(/^\d{2}:\d{2}-\d{2}:\d{2}$/, "Invalid AI window format (HH:MM-HH:MM)");

const TaxonomyGroupSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().min(1),
  })
  .strict();

export const RhizomeConfigSchema = z
  .object({
    config_version: z.literal(CURRENT_CONFIG_VERSION),
    vault: z
      .object({
        path: z.string().min(1),
        research_root: z.string().min(1),
        studies_folder: z.string().min(1),
        assets_folder: z.string().min(1),
        study_notes_folder: z.string().min(1),
        imports_folder: z.string().min(1),
        system_folder: z.string().min(1),
      })
      .strict(),
    zotero: z
      .object({
        enabled: z.boolean(),
        user_id: z.string().min(1),
        api_key: z.string().min(1),
        collections: z.array(z.string()),
        skip_item_types: z.array(z.string().min(1)),
      })
      .strict(),
    pdf: z
      .object({
        sources: z.array(z.enum(["zotero", "unpaywall", "europepmc"])) .min(1),
        unpaywall_email: z.email(),
        download_timeout_ms: z.number().int().positive(),
        max_file_size_mb: z.number().int().positive(),
      })
      .strict(),
    parser: z
      .object({
        active_provider: z.literal("marker"),
        marker: z
          .object({
            version: z.string().min(1),
            timeout_ms: z.number().int().positive(),
            force_ocr: z.boolean(),
            python_env: z.string().min(1),
          })
          .strict(),
      })
      .strict(),
    ai: z
      .object({
        windows: z.array(AiWindowSchema).min(1),
        timezone: z.string().min(1),
        batch_size: z.number().int().positive(),
        cooldown_seconds: z.number().int().nonnegative(),
        strategy: z.enum(["piped", "two_pass", "single_pass"]),
        max_input_tokens: z.number().int().positive(),
        claude_binary: z.string().min(1),
        summarizer: z
          .object({
            skill_file: z.string().min(1),
            max_turns: z.number().int().positive(),
            timeout_ms: z.number().int().positive(),
          })
          .strict(),
        classifier: z
          .object({
            skill_file: z.string().min(1),
            max_turns: z.number().int().positive(),
            timeout_ms: z.number().int().positive(),
          })
          .strict(),
      })
      .strict(),
    taxonomy: z
      .object({
        auto_promote_threshold: z.number().int().positive(),
        deprecation_days: z.number().int().positive(),
        max_pending_before_review: z.number().int().positive(),
        groups: z.array(TaxonomyGroupSchema).min(1),
      })
      .strict(),
    pipeline: z
      .object({
        max_retries: z.number().int().nonnegative(),
        single_writer: z.boolean(),
        lock_path: z.string().min(1),
        lock_stale_minutes: z.number().int().positive(),
        ai_required_stages: z.array(z.string().min(1)),
        skip_stages: z.array(z.string().min(1)),
      })
      .strict(),
    audit: z
      .object({
        markdown_log: z.boolean(),
        retain_debug_output: z.boolean(),
      })
      .strict(),
    data: z
      .object({
        db_path: z.string().min(1),
        skills_dir: z.string().min(1),
      })
      .strict(),
  })
  .strict();

export type RhizomeConfig = z.infer<typeof RhizomeConfigSchema>;

export function parseConfig(config: unknown): RhizomeConfig {
  return RhizomeConfigSchema.parse(config);
}

export function safeParseConfig(config: unknown) {
  return RhizomeConfigSchema.safeParse(config);
}
