import { getStore } from "@netlify/blobs";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

export const config = { path: "/api/*" };

const LIMIT = (Number(process.env.TIME_LIMIT_SEC) || 600) * 1000; // время на тест
const GRACE = 5000; // допуск на задержку сети, мс

// Первый вариант в каждом вопросе — верный. Порядок перемешивается при старте попытки.
const QUESTIONS = [
  { q: "Каким документом утверждена Государственная программа инновационного развития (ГПИР) на 2026–2030 годы?", o: ["Указ Президента от 21 декабря 2025 г. № 448", "Указ Президента от 1 апреля 2025 г. № 135", "Постановление Совмина от 14 февраля 2026 г. № 79", "Указ Президента от 22 июля 2026 г. № 249"] },
  { q: "Какой показатель исключён из целевых для республиканских заказчиков в ГПИР 2026–2030?", o: ["Удельный вес отгруженной инновационной продукции", "Доля экспорта наукоёмкой продукции", "Доля инновационно активных организаций", "Объём затрат на НИОКР"] },
  { q: "Какой целевой ориентир к 2030 году установлен для доли принципиально новой продукции в отгруженной инновационной продукции?", o: ["57,2%", "33,5%", "39%", "46,5%"] },
  { q: "Какова целевая доля экспорта наукоёмкой и высокотехнологичной продукции в общем экспорте к 2030 году?", o: ["39%", "45%", "54,5%", "83%"] },
  { q: "Для кого в ГПИР 2026–2030 введена категория «локальных» инновационных проектов?", o: ["Для малых и средних предприятий", "Для крупных холдингов", "Для научных институтов НАН", "Для резидентов ПВТ"] },
  { q: "Сколько крупных инновационных проектов вошло в перечень по Постановлению Совмина № 79?", o: ["42", "10", "50", "557"] },
  { q: "Что сказал премьер-министр о показателе 46,5% инновационной продукции в отгрузке при задании 33,5%?", o: ["Реально новой для мира продукции за этими цифрами нет", "Показатель говорит о мировом лидерстве", "Задание нужно повысить до 50%", "Показатель нельзя сравнивать с заданием"] },
  { q: "Как изменилось финансирование ГПИР на пятилетку в течение 2026 года?", o: ["Выросло с 1,834 до 2,081 млрд руб.", "Выросло с 789 до 928,6 млрд руб.", "Выросло с 2,1 до 2,5 млрд руб.", "Осталось без изменений"] },
  { q: "Сколько организаций осуществляли затраты на инновации в 2025 году по данным Белстата?", o: ["637", "565", "557", "266"] },
  { q: "Какая доля резидентов ПВТ разрабатывает и реализует продукты на внутреннем рынке?", o: ["Более 60%", "Около 10%", "Около 30%", "Менее 50%"] },
  { q: "Какое предприятие выпустило медтехнику на 100% из белорусских комплектующих?", o: ["«Атлант»", "«Горизонт»", "«Гомсельмаш»", "БМЗ"] },
  { q: "У какого предприятия на 1 сентября 2026 года 32% продукции инновационная, а в разработке 170 НИОКР?", o: ["Белорусский металлургический завод", "«Штадлер Минск»", "«Гомсельмаш»", "Минский моторный завод"] },
  { q: "Сколько электропоездов предусматривает проект L-4093 «Штадлер Минск» для Белорусской железной дороги?", o: ["30 электропоездов (120 вагонов)", "12 электропоездов", "44 электропоезда", "120 электропоездов"] }
];

const FIO = /^[А-ЯЁа-яё]{2,}(?:-[А-ЯЁа-яё]{2,})?(?:\s+[А-ЯЁа-яё]{2,}(?:-[А-ЯЁа-яё]{2,})?){2,}$/;
const clean = (n) => String(n || "").trim().replace(/\s+/g, " ");
const keyOf = (n) => "a_" + createHash("sha256").update(clean(n).toLowerCase().replace(/ё/g, "е")).digest("hex").slice(0, 32);
const shuffle = (a) => { a = [...a]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const buildQs = () => shuffle(QUESTIONS.map((_, i) => i)).map((i) => ({ i, o: shuffle(QUESTIONS[i].o.map((_, k) => k)) }));
const pub = (r, now) => ({
  token: r.id, name: r.name, remainingMs: Math.max(0, r.deadline - now),
  questions: r.qs.map((q) => ({ q: QUESTIONS[q.i].q, o: q.o.map((k) => QUESTIONS[q.i].o[k]) }))
});
const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

async function board(store) {
  const { blobs } = await store.list({ prefix: "a_" });
  const rows = (await Promise.all(blobs.map((b) => store.get(b.key, { type: "json" })))).filter((r) => r && r.status === "finished");
  rows.sort((a, b) => b.score - a.score || a.timeMs - b.timeMs);
  return { total: QUESTIONS.length, rows: rows.map((r, i) => ({ place: i + 1, name: r.name, score: r.score, timeMs: r.timeMs })) };
}

async function start(req, store) {
  const { name, token } = await req.json().catch(() => ({}));
  const full = clean(name);
  if (!FIO.test(full)) return json({ error: "Введите полное ФИО кириллицей: фамилия, имя и отчество." }, 400);
  const key = keyOf(full), now = Date.now();
  const rec = { id: randomUUID(), name: full, startedAt: now, deadline: now + LIMIT, status: "started", qs: buildQs() };
  try { await store.setJSON(key, rec, { onlyIfNew: true }); } catch (e) { console.error("start write", e); } // атомарно: вторая попытка невозможна
  const old = await store.get(key, { type: "json" });
  if (old && old.id === rec.id) return json(pub(rec, now)); // запись создана нами
  if (old && old.status === "started" && token && token === old.id && now < old.deadline) return json(pub(old, now)); // продолжение после обновления страницы
  return json({ error: "Для этого ФИО попытка уже использована. Тест можно пройти только один раз." }, 409);
}

async function submit(req, store) {
  const { name, token, answers } = await req.json().catch(() => ({}));
  const key = keyOf(name);
  const e = await store.getWithMetadata(key, { type: "json" });
  if (!e || !e.data || e.data.id !== token) return json({ error: "Попытка не найдена." }, 403);
  const r = e.data;
  if (r.status === "finished") return json({ error: "Ответы уже отправлены." }, 409);
  const now = Date.now(), late = now > r.deadline + GRACE;
  let score = 0;
  if (!late && Array.isArray(answers)) r.qs.forEach((q, n) => { if (q.o[answers[n]] === 0) score++; });
  const timeMs = Math.min(now, r.deadline) - r.startedAt;
  const fin = { ...r, status: "finished", score, timeMs, finishedAt: now, late };
  try { await store.setJSON(key, fin, { onlyIfMatch: e.etag }); } catch (err) { console.error("submit write", err); }
  const chk = await store.get(key, { type: "json" });
  if (!chk || chk.finishedAt !== now) {
    if (chk && chk.status === "finished") return json({ error: "Ответы уже отправлены." }, 409);
    return json({ error: "Не удалось сохранить ответы. Нажмите «Отправить ещё раз»." }, 500);
  }
  const b = await board(store);
  const me = b.rows.find((x) => x.name === r.name);
  return json({ score, total: QUESTIONS.length, timeMs, late, place: me ? me.place : null, of: b.rows.length });
}

const sha = (v) => createHash("sha256").update(String(v)).digest();
const authed = (req) => {
  const k = process.env.ADMIN_KEY || "", g = req.headers.get("x-admin-key") || "";
  if (!k || !g) return false;
  return timingSafeEqual(sha(g), sha(k));
};

async function adminList(store) {
  const { blobs } = await store.list({ prefix: "a_" });
  const now = Date.now();
  const rows = (await Promise.all(blobs.map(async (b) => {
    const r = await store.get(b.key, { type: "json" });
    if (!r) return null;
    const status = r.status === "finished" ? "finished" : now < r.deadline ? "running" : "abandoned";
    return { key: b.key, name: r.name, status, score: r.score ?? null, timeMs: r.timeMs ?? null, startedAt: r.startedAt, late: !!r.late };
  }))).filter(Boolean);
  rows.sort((a, b) => b.startedAt - a.startedAt);
  return { total: QUESTIONS.length, limitSec: LIMIT / 1000, rows };
}

async function adminDelete(req, store) {
  const { key, all } = await req.json().catch(() => ({}));
  if (all === true) {
    const { blobs } = await store.list({ prefix: "a_" });
    await Promise.all(blobs.map((b) => store.delete(b.key)));
    return json({ ok: true, deleted: blobs.length });
  }
  if (typeof key !== "string" || !/^a_[0-9a-f]{32}$/.test(key)) return json({ error: "Неверный ключ" }, 400);
  await store.delete(key);
  return json({ ok: true, deleted: 1 });
}

export default async (req) => {
  const p = new URL(req.url).pathname.replace(/^\/api\/?/, "");
  const store = getStore({ name: "attempts", consistency: "strong" });
  try {
    if (req.method === "GET" && p === "config") return json({ limitSec: LIMIT / 1000, count: QUESTIONS.length });
    if (req.method === "GET" && p === "leaderboard") return json(await board(store));
    if (req.method === "POST" && p === "start") return await start(req, store);
    if (req.method === "POST" && p === "submit") return await submit(req, store);
    if (p.startsWith("admin/")) {
      if (!authed(req)) return json({ error: "Неверный ключ администратора" }, 403);
      if (req.method === "GET" && p === "admin/list") return json(await adminList(store));
      if (req.method === "POST" && p === "admin/delete") return await adminDelete(req, store);
    }
  } catch (err) {
    console.error(err);
    return json({ error: "Ошибка сервера: " + (err && err.message ? err.message : err) }, 500);
  }
  return json({ error: "Не найдено" }, 404);
};
