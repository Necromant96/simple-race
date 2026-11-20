// =========================================================
// Простой сервер для игры «Гонка»
// Без внешних библиотек: используем только встроенный Node.js.
// Запуск: node server.js   затем открыть http://localhost:3000
// =========================================================

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");

const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, "game.db");

// --- 1. База данных ---
// Файл game.db создастся автоматически при первом запуске.
const db = new DatabaseSync(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    login         TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    salt          TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS scores (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL,
    score      INTEGER NOT NULL,
    distance   INTEGER NOT NULL,
    overtakes  INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

// --- 2. Вспомогательные функции ---

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

// Хешируем пароль: соль + scrypt. В базе лежит не сам пароль, а хеш.
function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString("hex");
}

function checkPassword(password, salt, hash) {
  const actual = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, "hex");
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  db.prepare("INSERT INTO sessions (token, user_id) VALUES (?, ?)").run(token, userId);
  return token;
}

function setSessionCookie(res, token) {
  // HttpOnly — JavaScript не сможет прочитать cookie (защита от XSS)
  res.setHeader(
    "Set-Cookie",
    `session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${60 * 60 * 24 * 7}`
  );
}

function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", "session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
}

// Данные о пользователе, которые отправляем на страницу
function userInfo(userId) {
  const user = db.prepare("SELECT id, login FROM users WHERE id = ?").get(userId);
  if (!user) return null;

  const stats = db
    .prepare("SELECT MAX(score) AS best, COUNT(*) AS races FROM scores WHERE user_id = ?")
    .get(userId);

  return {
    id: user.id,
    login: user.login,
    bestScore: stats.best || 0,
    races: stats.races || 0,
  };
}

// --- 3. Мидлвэйеры ---
// Мидлвэйер — это функция, которая выполняется ДО основного обработчика.
// Она может подготовить данные (req.body, req.user) или остановить запрос.

// Читает JSON из тела POST-запроса
function jsonMiddleware(req, res, next) {
  if (req.method !== "POST") return next();

  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
    if (body.length > 100000) req.destroy(); // защита от слишком больших запросов
  });

  req.on("end", () => {
    try {
      req.body = body ? JSON.parse(body) : {};
      next();
    } catch (error) {
      sendJson(res, 400, { error: "Некорректный JSON" });
    }
  });
}

// Находит пользователя по cookie и записывает его в req.user
function sessionMiddleware(req, res, next) {
  const cookies = (req.headers.cookie || "").split(";");
  const sessionCookie = cookies
    .map((item) => item.trim().split("="))
    .find(([name]) => name === "session");

  req.sessionToken = sessionCookie ? sessionCookie[1] : null;
  req.user = null;

  if (req.sessionToken) {
    const row = db
      .prepare(`
        SELECT users.id, users.login
        FROM sessions
        JOIN users ON users.id = sessions.user_id
        WHERE sessions.token = ?
      `)
      .get(req.sessionToken);

    if (row) req.user = { id: row.id, login: row.login };
  }

  next();
}

// Пускает дальше только вошедших пользователей
function requireAuth(req, res, next) {
  if (!req.user) return sendJson(res, 401, { error: "Нужно войти в аккаунт" });
  next();
}

// Запускает цепочку мидлвэйеров, а потом сам обработчик
function runMiddlewares(req, res, middlewares, handler) {
  let index = 0;

  function next(error) {
    if (error) return sendJson(res, 500, { error: "Ошибка сервера" });

    const middleware = middlewares[index++];
    if (!middleware) {
      Promise.resolve()
        .then(() => handler(req, res))
        .catch(() => sendJson(res, 500, { error: "Ошибка сервера" }));
      return;
    }

    try {
      middleware(req, res, next);
    } catch (error) {
      sendJson(res, 500, { error: "Ошибка сервера" });
    }
  }

  next();
}

// --- 4. Обработчики API ---

function registerHandler(req, res) {
  const login = String(req.body.login || "").trim();
  const password = String(req.body.password || "");

  if (!/^[A-Za-zА-Яа-яЁё0-9_-]{3,20}$/.test(login)) {
    return sendJson(res, 400, { error: "Логин: от 3 до 20 букв, цифр, _ или -" });
  }
  if (password.length < 4) {
    return sendJson(res, 400, { error: "Пароль: минимум 4 символа" });
  }
  if (db.prepare("SELECT id FROM users WHERE login = ?").get(login)) {
    return sendJson(res, 409, { error: "Такой логин уже занят" });
  }

  const salt = crypto.randomBytes(16).toString("hex");
  const hash = hashPassword(password, salt);
  const info = db
    .prepare("INSERT INTO users (login, password_hash, salt) VALUES (?, ?, ?)")
    .run(login, hash, salt);

  const userId = Number(info.lastInsertRowid);
  const token = createSession(userId);
  setSessionCookie(res, token);

  sendJson(res, 201, { ok: true, user: userInfo(userId) });
}

function loginHandler(req, res) {
  const login = String(req.body.login || "").trim();
  const password = String(req.body.password || "");

  const user = db
    .prepare("SELECT id, login, password_hash, salt FROM users WHERE login = ?")
    .get(login);

  if (!user || !checkPassword(password, user.salt, user.password_hash)) {
    return sendJson(res, 401, { error: "Неверный логин или пароль" });
  }

  const token = createSession(user.id);
  setSessionCookie(res, token);

  sendJson(res, 200, { ok: true, user: userInfo(user.id) });
}

function logoutHandler(req, res) {
  if (req.sessionToken) {
    db.prepare("DELETE FROM sessions WHERE token = ?").run(req.sessionToken);
  }
  clearSessionCookie(res);
  sendJson(res, 200, { ok: true });
}

function meHandler(req, res) {
  sendJson(res, 200, { user: req.user ? userInfo(req.user.id) : null });
}

function saveScoreHandler(req, res) {
  const score = Math.floor(Number(req.body.score));
  const distance = Math.floor(Number(req.body.distance));
  const overtakes = Math.floor(Number(req.body.overtakes));

  if (
    !Number.isFinite(score) || score < 0 ||
    !Number.isFinite(distance) || distance < 0 ||
    !Number.isFinite(overtakes) || overtakes < 0
  ) {
    return sendJson(res, 400, { error: "Некорректные данные гонки" });
  }

  db.prepare(
    "INSERT INTO scores (user_id, score, distance, overtakes) VALUES (?, ?, ?, ?)"
  ).run(req.user.id, score, distance, overtakes);

  sendJson(res, 201, { ok: true, user: userInfo(req.user.id) });
}

function getScoresHandler(req, res) {
  const rows = db
    .prepare(`
      SELECT users.login, scores.score, scores.distance, scores.overtakes, scores.created_at
      FROM scores
      JOIN users ON users.id = scores.user_id
      ORDER BY scores.score DESC, scores.id ASC
      LIMIT 10
    `)
    .all();

  const scores = rows.map((row) => ({
    login: row.login,
    score: row.score,
    distance: row.distance,
    overtakes: row.overtakes,
    date: row.created_at,
  }));

  sendJson(res, 200, { scores });
}

// --- 5. Таблица маршрутов ---
// У каждого маршрута свой список мидлвэйеров.

const routes = [
  { method: "POST", path: "/api/register", middlewares: [jsonMiddleware], handler: registerHandler },
  { method: "POST", path: "/api/login", middlewares: [jsonMiddleware], handler: loginHandler },
  { method: "POST", path: "/api/logout", middlewares: [sessionMiddleware], handler: logoutHandler },
  { method: "GET", path: "/api/me", middlewares: [sessionMiddleware], handler: meHandler },
  {
    method: "GET",
    path: "/api/health",
    middlewares: [],
    handler: (req, res) => sendJson(res, 200, { ok: true }),
  },
  {
    method: "POST",
    path: "/api/scores",
    middlewares: [jsonMiddleware, sessionMiddleware, requireAuth],
    handler: saveScoreHandler,
  },
  { method: "GET", path: "/api/scores", middlewares: [sessionMiddleware], handler: getScoresHandler },
];

// --- 6. Раздача обычных файлов (HTML, CSS, JS) ---

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

function serveStatic(req, res, pathname) {
  const relativePath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const filePath = path.resolve(__dirname, relativePath);

  // Не даём выйти за папку проекта
  if (filePath !== __dirname && !filePath.startsWith(__dirname + path.sep)) {
    return sendJson(res, 403, { error: "Доступ запрещён" });
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("Файл не найден");
    }

    res.writeHead(200, {
      "Content-Type": MIME_TYPES[path.extname(filePath)] || "application/octet-stream",
    });
    res.end(data);
  });
}

// --- 7. Сервер ---

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;

  const route = routes.find((item) => item.method === req.method && item.path === pathname);
  if (route) return runMiddlewares(req, res, route.middlewares, route.handler);

  if (pathname.startsWith("/api/")) {
    return sendJson(res, 404, { error: "Маршрут не найден" });
  }

  serveStatic(req, res, pathname);
});

server.listen(PORT, () => {
  console.log(`Игра запущена: http://localhost:${PORT}`);
});
