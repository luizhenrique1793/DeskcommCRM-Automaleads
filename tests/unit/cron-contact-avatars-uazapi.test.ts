import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * O cron de fotos de perfil (`app/api/v1/cron/contact-avatars/route.ts`) só
 * sabia ler `channel_sessions.waha_session_name` como `ref` — para QUALQUER
 * outro provider (UAZAPI, Meta, Zernio), `ref` vinha `undefined` e o contato
 * caía direto em "sem foto", mesmo com `fetchProfilePictureUrl` implementado
 * no adapter. Corrigido para usar `resolveSessionRef` (o mesmo seam que
 * `media-persist-worker.ts` e a rota de mídia já usam). Este teste prova que
 * uma sessão UAZAPI `WORKING` agora tem a foto buscada e persistida.
 */

const CONTATO = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ORG = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const CAMINHO = `${ORG}/avatars/${CONTATO}.jpg`;

let linhasAfetadas: { id: string }[] = [{ id: CONTATO }];
const updatesContacts: { patch: Record<string, unknown>; filtros: Record<string, unknown> }[] = [];
const uploads: string[] = [];
const chamadasDoAdapter: { sessionRef: string; recipient: string }[] = [];

vi.mock("@/lib/env", () => ({
  env: { INTERNAL_CRON_SECRET: "segredo-de-teste", INTERNAL_SECRET: "segredo-de-teste" },
}));

vi.mock("@/lib/channels", () => ({
  DEFAULT_CHANNEL_PROVIDER: "waha",
  CHANNEL_SESSION_REF_COLUMNS:
    "provider, waha_session_name, meta_phone_number_id, zernio_account_id, uazapi_instance_id",
  // Mesma tradução real de `lib/channels/session-ref.ts` — a coluna do ref
  // muda por provider, nunca é `waha_session_name` fixo.
  resolveSessionRef: (s: {
    provider: string;
    waha_session_name?: string | null;
    uazapi_instance_id?: string | null;
  }) => (s.provider === "uazapi" ? s.uazapi_instance_id : s.waha_session_name),
  getAdapter: () => ({
    fetchProfilePictureUrl: async (input: { sessionRef: string; recipient: string }) => {
      chamadasDoAdapter.push(input);
      return "https://cdn.exemplo.invalid/foto-uazapi.jpg";
    },
  }),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => ({
      select: () => {
        const dados =
          tabela === "contacts"
            ? [
                {
                  id: CONTATO,
                  organization_id: ORG,
                  wa_identity: "phone:+5511988887777",
                  avatar_storage_path: null,
                },
              ]
            // Sessão UAZAPI: `waha_session_name` é NULL por CHECK
            // (`channel_sessions_provider_ref_check`) — só `uazapi_instance_id`
            // é preenchido. Era exatamente essa linha que o cron ignorava.
            : { provider: "uazapi", waha_session_name: null, uazapi_instance_id: "pordosol2" };
        const proxy: Record<string, unknown> = new Proxy(
          {},
          {
            get(_t, prop) {
              if (prop === "then") {
                return (ok: (v: unknown) => unknown) => Promise.resolve({ data: dados, error: null }).then(ok);
              }
              if (prop === "maybeSingle") return async () => ({ data: dados, error: null });
              return () => proxy;
            },
          },
        );
        return proxy;
      },
      update: (patch: Record<string, unknown>) => {
        const filtros: Record<string, unknown> = {};
        const proxy: Record<string, unknown> = new Proxy(
          {},
          {
            get(_t, prop) {
              if (prop === "eq") {
                return (col: string, val: unknown) => {
                  filtros[col] = val;
                  return proxy;
                };
              }
              if (prop === "select") {
                return () => {
                  updatesContacts.push({ patch, filtros });
                  return Promise.resolve({ data: linhasAfetadas, error: null });
                };
              }
              return () => proxy;
            },
          },
        );
        return proxy;
      },
      upsert: async () => ({ error: null }),
    }),
    storage: {
      from: () => ({
        upload: async (caminho: string) => {
          uploads.push(caminho);
          return { error: null };
        },
      }),
    },
  }),
}));

import { POST } from "@/app/api/v1/cron/contact-avatars/route";

beforeEach(() => {
  updatesContacts.length = 0;
  uploads.length = 0;
  chamadasDoAdapter.length = 0;
  linhasAfetadas = [{ id: CONTATO }];
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 })),
  );
});

function chamar(): Promise<Response> {
  return POST(
    new Request("http://localhost/api/v1/cron/contact-avatars", {
      method: "POST",
      headers: { authorization: "Bearer segredo-de-teste" },
    }) as never,
  );
}

describe("cron de fotos de perfil — sessão UAZAPI (não-WAHA)", () => {
  it("resolve o ref pelo uazapi_instance_id, busca a foto e grava avatar_storage_path", async () => {
    const resposta = await chamar();
    expect(resposta.status).toBe(200);

    expect(chamadasDoAdapter).toHaveLength(1);
    expect(chamadasDoAdapter[0]).toMatchObject({ sessionRef: "pordosol2" });

    expect(uploads).toContain(CAMINHO);
    const carimbo = updatesContacts.find((u) => u.patch.avatar_storage_path === CAMINHO);
    expect(carimbo, "o cron deveria ter gravado o caminho da foto para a sessão UAZAPI").toBeDefined();
  });
});
