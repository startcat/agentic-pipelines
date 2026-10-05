import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

// `.strict()`: un canal tiene tres campos — `type` y `run`, obligatorios, más
// `env`, opcional con `.default([])`. Un typo en `type` o `run` ya fallaría
// igualmente como "Required" nombrando el campo correcto, pero un typo en
// `env` (p. ej. `enviroment: [...]`) NO fallaría así sin `.strict()`: la
// clave desconocida se descartaría en silencio y el `env` real quedaría en
// `[]` sin avisar. `.strict()` es aquí la defensa principal contra ese caso
// del campo opcional, no solo un cierre residual sobre los dos obligatorios
// — por el mismo motivo que el resto de este fichero: ninguna clave
// desconocida debe desaparecer en silencio.
const channelSchema = z
  .object({
    type: z.literal('shell'),
    run: z.string(),
    /**
     * Nombres de secretos que este canal necesita, nunca valores — mismo
     * patrón que `requires.env` de un pipeline y `mcp_servers.<x>.env`.
     * Resueltos contra el `.env` del repo de datos solo cuando el canal se
     * invoca de verdad (`dispatchNotify`), nunca expuestos al
     * pipeline que disparó el notify.
     */
    env: z.array(z.string()).default([]),
  })
  .strict();

// La clave YAML es `on_error` ("defaults: { on_error: stop, ... }"),
// coherente con el resto del formato, ya snake_case: `stale_count`,
// `pr_url`, `last_success`. El campo interno se expone como `onError`
// porque los identificadores van en camelCase inglés (convención de todo
// el código); `parseRepoConfig` hace ese mapeo explícito
// abajo, igual que `parsePipeline` en `schema/pipeline.ts`.
//
// `.strict()` en `repoConfigSchema`, en el objeto `defaults` y en las dos
// formas anidadas (`retry` en su rama objeto, `notify`): sin esto, Zod
// descarta cualquier clave desconocida en silencio — que es exactamente el
// defecto que `on_error` destapó, y que sin `.strict()` seguiría abierto
// para cualquier otra clave o typo (`onError`, `retries`, `notifi`, una
// clave de nivel raíz inventada). `pipeline.ts` ya aplica el mismo
// tratamiento a su `pipelineSchema`/`defaultsSchema`/pasos; esto lo iguala
// aquí, en el hermano que valida `pipelines.yaml`.
const repoConfigSchema = z
  .object({
    channels: z.record(channelSchema).default({}),
    defaults: z
      .object({
        on_error: z.enum(['stop', 'continue']).optional(),
        retry: z
          .union([
            z.number(),
            z.object({ attempts: z.number(), on: z.enum(['transient', 'any']) }).strict(),
          ])
          .optional(),
        timeout: z.string().optional(),
        // Misma forma que `pipelineSchema.notify` en `schema/pipeline.ts`,
        // incluido `stale_after` — ver el comentario de allí.
        notify: z
          .object({
            on: z.array(z.enum(['failed', 'success', 'skipped'])),
            stale_after: z.string().regex(/^\d+(s|m|h)$/, 'debe ser un número seguido de s, m o h (p. ej. 72h)').optional(),
            channel: z.string(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .default({}),
  })
  .strict();

type RawRepoConfig = z.infer<typeof repoConfigSchema>;

export type RepoConfig = {
  channels: RawRepoConfig['channels'];
  defaults: {
    onError?: 'stop' | 'continue';
    retry?: RawRepoConfig['defaults']['retry'];
    timeout?: string;
    notify?: RawRepoConfig['defaults']['notify'];
  };
};

/** Parsea `pipelines.yaml`, la configuración común del repo de datos. */
export function parseRepoConfig(yamlText: string): RepoConfig {
  const result = repoConfigSchema.safeParse(parseYaml(yamlText) ?? {});
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new Error(`pipelines.yaml inválido:\n  - ${issues.join('\n  - ')}`);
  }
  const { channels, defaults } = result.data;
  return {
    channels,
    defaults: {
      onError: defaults.on_error,
      retry: defaults.retry,
      timeout: defaults.timeout,
      notify: defaults.notify,
    },
  };
}
