// =============================================
// Migração: Cloudinary -> ImageKit (roda UMA vez, no seu computador)
// =============================================
// O que faz:
//   1. Lê todos os imóveis da coleção "properties" no Firestore.
//   2. Para cada foto do Cloudinary, pede ao ImageKit para buscá-la pela URL.
//   3. Troca os links no Firestore e guarda os antigos em "imagesCloudinary".
// Fotos que já não estão em nenhum imóvel (órfãs) ficam para trás.
//
// Como rodar (Node 18 ou mais novo):
//   Windows (PowerShell):
//     $env:IMAGEKIT_PRIVATE_KEY="private_..."; node scripts/migrar-cloudinary-para-imagekit.mjs
//   Linux/Mac:
//     IMAGEKIT_PRIVATE_KEY="private_..." node scripts/migrar-cloudinary-para-imagekit.mjs
//
// Primeiro rode com --teste para só ver o que seria feito, sem mudar nada:
//     node scripts/migrar-cloudinary-para-imagekit.mjs --teste
// =============================================

const PROJECT_ID = "habileads-f8abe";
const API_KEY = "AIzaSyDvAkUHbtTRrBkc-SqaGZ4F9UqbAZJmeGc";
const FIRESTORE = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
const PRIVATE_KEY = process.env.IMAGEKIT_PRIVATE_KEY;
const DRY_RUN = process.argv.includes("--teste");

if (!PRIVATE_KEY && !DRY_RUN) {
  console.error("Defina a variável IMAGEKIT_PRIVATE_KEY antes de rodar (veja o topo do arquivo).");
  process.exit(1);
}

const isCloudinary = (url) => typeof url === "string" && url.includes("res.cloudinary.com/");

async function listProperties() {
  const docs = [];
  let pageToken = "";
  do {
    const url = `${FIRESTORE}/properties?pageSize=300&key=${API_KEY}${pageToken ? `&pageToken=${pageToken}` : ""}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Erro ao ler Firestore: ${res.status} ${await res.text()}`);
    const data = await res.json();
    docs.push(...(data.documents || []));
    pageToken = data.nextPageToken || "";
  } while (pageToken);
  return docs;
}

async function uploadFromUrl(url, propertyId) {
  const original = url.split("/").pop().split("?")[0] || "foto.jpg";
  const form = new FormData();
  form.append("file", url);
  form.append("fileName", original.replace(/[^a-zA-Z0-9._-]+/g, "_"));
  form.append("folder", `/habileads/${propertyId}`);
  const res = await fetch("https://upload.imagekit.io/api/v1/files/upload", {
    method: "POST",
    headers: { Authorization: "Basic " + Buffer.from(PRIVATE_KEY + ":").toString("base64") },
    body: form,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || `upload falhou (${res.status})`);
  return data.url;
}

const toStrArray = (list) => ({
  arrayValue: { values: list.map((stringValue) => ({ stringValue })) },
});

async function updateDoc(docName, images, oldImages) {
  const mask = ["images", "image", "imagesCloudinary"]
    .map((f) => `updateMask.fieldPaths=${f}`)
    .join("&");
  const res = await fetch(`https://firestore.googleapis.com/v1/${docName}?${mask}&key=${API_KEY}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      fields: {
        images: toStrArray(images),
        image: { stringValue: images[0] || "" },
        imagesCloudinary: toStrArray(oldImages),
      },
    }),
  });
  if (!res.ok) throw new Error(`Erro ao gravar no Firestore: ${res.status} ${await res.text()}`);
}

const docs = await listProperties();
let migrated = 0;
let failed = 0;

for (const doc of docs) {
  const f = doc.fields || {};
  if (f.deleted?.booleanValue) continue;
  const id = doc.name.split("/").pop();
  const images = (f.images?.arrayValue?.values || []).map((v) => v.stringValue).filter(Boolean);
  const pending = images.filter(isCloudinary);
  if (!pending.length) continue;

  console.log(`\n🏠 ${f.title?.stringValue || id}: ${pending.length} foto(s) do Cloudinary`);
  if (DRY_RUN) continue;

  const newImages = [];
  let ok = true;
  for (const url of images) {
    if (!isCloudinary(url)) {
      newImages.push(url);
      continue;
    }
    try {
      const newUrl = await uploadFromUrl(url, id);
      newImages.push(newUrl);
      migrated++;
      console.log("   ✅", newUrl);
    } catch (error) {
      ok = false;
      failed++;
      newImages.push(url); // mantém a antiga para não perder a foto
      console.log("   ❌", url, "-", error.message);
    }
  }
  await updateDoc(doc.name, newImages, images);
  if (!ok) console.log("   ⚠️ Algumas fotos falharam; rode o script de novo depois.");
}

console.log(
  DRY_RUN
    ? "\nModo teste: nada foi alterado."
    : `\nPronto! ${migrated} foto(s) migrada(s), ${failed} com erro.`,
);
