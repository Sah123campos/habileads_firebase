// =============================================
// Habileads — Worker da Cloudflare para o ImageKit
// =============================================
// Guarda a Private key do ImageKit em segredo e faz duas coisas:
//   POST /auth    -> devolve a assinatura para o site enviar UMA foto
//   POST /delete  -> apaga fotos do ImageKit (recebe as URLs)
//
// Só atende quem manda a senha de admin correta. A senha é conferida
// com o hash salvo no Firestore (settings/adminCredentials), então se a
// senha for trocada no site, o Worker passa a aceitar a nova sozinho.
//
// Na Cloudflare, cadastre o segredo (Settings > Variables and Secrets):
//   IMAGEKIT_PRIVATE_KEY  (tipo "Secret")
// =============================================

const FIREBASE_PROJECT_ID = "habileads-f8abe";
const IMAGEKIT_URL_ENDPOINT = "https://ik.imagekit.io/mbslapvpk";
const ALLOWED_ORIGINS = [
  "https://sah123campos.github.io",
  "http://localhost:5500",
  "http://127.0.0.1:5500",
];

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const cors = {
      "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin)
        ? origin
        : ALLOWED_ORIGINS[0],
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      Vary: "Origin",
    };
    const reply = (body, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { ...cors, "Content-Type": "application/json" },
      });

    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    if (request.method !== "POST") return reply({ error: "Método não permitido" }, 405);
    if (!env.IMAGEKIT_PRIVATE_KEY) {
      return reply({ error: "IMAGEKIT_PRIVATE_KEY não configurada no Worker" }, 500);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return reply({ error: "JSON inválido" }, 400);
    }

    if (!(await isAdminPassword(body.password))) {
      return reply({ error: "Senha de admin inválida" }, 401);
    }

    const path = new URL(request.url).pathname;

    if (path === "/auth") {
      const token = crypto.randomUUID();
      const expire = Math.floor(Date.now() / 1000) + 30 * 60; // 30 min
      const signature = await hmacSha1Hex(env.IMAGEKIT_PRIVATE_KEY, token + expire);
      return reply({ token, expire, signature });
    }

    if (path === "/delete") {
      const urls = Array.isArray(body.urls) ? body.urls.slice(0, 100) : [];
      const results = [];
      for (const url of urls) {
        results.push({ url, ...(await deleteByUrl(url, env.IMAGEKIT_PRIVATE_KEY)) });
      }
      return reply({ results });
    }

    return reply({ error: "Rota não encontrada" }, 404);
  },
};

async function isAdminPassword(password) {
  if (typeof password !== "string" || !password) return false;
  const docUrl = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/settings/adminCredentials`;
  const res = await fetch(docUrl);
  if (!res.ok) return false;
  const doc = await res.json();
  const savedHash = doc?.fields?.passwordHash?.stringValue;
  if (!savedHash) return false;
  return savedHash === (await sha256Hex(password));
}

async function deleteByUrl(url, privateKey) {
  if (typeof url !== "string" || !url.startsWith(IMAGEKIT_URL_ENDPOINT + "/")) {
    return { skipped: "não é uma foto do ImageKit" };
  }
  const filePath = decodeURIComponent(
    url.slice(IMAGEKIT_URL_ENDPOINT.length).split("?")[0],
  );
  const slash = filePath.lastIndexOf("/");
  const folder = filePath.slice(0, slash) || "/";
  const name = filePath.slice(slash + 1);
  const auth = { Authorization: "Basic " + btoa(privateKey + ":") };

  const query = new URLSearchParams({
    path: folder,
    searchQuery: `name = "${name.replace(/"/g, '\\"')}"`,
  });
  const list = await fetch(`https://api.imagekit.io/v1/files?${query}`, { headers: auth });
  if (!list.ok) return { error: `busca falhou (${list.status})` };
  const files = await list.json();
  const file = Array.isArray(files) ? files.find((f) => f.filePath === filePath) : null;
  if (!file) return { skipped: "não encontrada (já apagada?)" };

  const del = await fetch(`https://api.imagekit.io/v1/files/${file.fileId}`, {
    method: "DELETE",
    headers: auth,
  });
  return del.ok ? { deleted: true } : { error: `exclusão falhou (${del.status})` };
}

async function sha256Hex(text) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return toHex(hash);
}

async function hmacSha1Hex(key, message) {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  return toHex(await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(message)));
}

function toHex(buffer) {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
