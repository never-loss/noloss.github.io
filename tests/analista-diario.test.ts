import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
const root = join(import.meta.dirname, "..");
test("Analista Diário: cartão honesto, NO TRADE, não seleccionável", () => {
  const html = readFileSync(join(root, "public/bybit.html"), "utf8");
  assert.match(html, /Analista Diário: sem garantia de lucro — só opera se a evidência passar a porta/);
  const card = html.slice(html.indexOf('id="cardAnalistaDiario"'), html.indexOf("</article>", html.indexOf('id="cardAnalistaDiario"')));
  assert.match(card, /NO TRADE/);
  assert.doesNotMatch(card, /data-preset/);
  assert.doesNotMatch(html, /value="analista_diario"/);
});
test("Analista Diário: resultado pré-registado guardado, nenhuma variante passa", () => {
  const j = JSON.parse(readFileSync(join(root, "notes/data/analista-diario-2026-10-27.json"), "utf8"));
  assert.equal(j.results.length, 6);
  assert.ok(j.results.every((r: { pass: boolean }) => !r.pass));
});
