// =========================================================
// Простая игра «Гонка» на HTML Canvas
// Код разделён на части: настройки, состояние, API, управление,
// обновление игры и отрисовка.
// =========================================================

// --- 1. Получаем элементы со страницы ---
const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");

const distanceLabel = document.getElementById("distance");
const speedLabel = document.getElementById("speed");
const scoreLabel = document.getElementById("score");
const bestLabel = document.getElementById("best");

const overlay = document.getElementById("overlay");
const overlayTitle = document.getElementById("overlay-title");
const overlayText = document.getElementById("overlay-text");
const startButton = document.getElementById("start-button");

const authForm = document.getElementById("auth-form");
const loginInput = document.getElementById("login");
const passwordInput = document.getElementById("password");
const registerButton = document.getElementById("register-button");
const logoutButton = document.getElementById("logout-button");
const userInfo = document.getElementById("user-info");
const userName = document.getElementById("user-name");
const racesLabel = document.getElementById("races");
const userBestLabel = document.getElementById("user-best");
const authStatus = document.getElementById("auth-status");
const resultsBody = document.getElementById("results-body");

// --- 2. Настройки игры (меняйте числа и смотрите, что получится) ---
const WIDTH = canvas.width;   // ширина игрового поля
const HEIGHT = canvas.height; // высота игрового поля

const ROAD_LEFT = 60;         // левый край дороги
const ROAD_RIGHT = 340;       // правый край дороги
const LANE_COUNT = 4;         // количество полос
const LANE_WIDTH = (ROAD_RIGHT - ROAD_LEFT) / LANE_COUNT;

const PLAYER_WIDTH = 38;
const PLAYER_HEIGHT = 64;

const MAX_SPEED = 6;           // максимальная скорость
const ACCELERATION = 0.15;    // как быстро разгоняемся
const BRAKING = 0.3;          // как быстро тормозим
const FRICTION = 0.04;        // замедление без нажатия кнопок
const STEERING = 4;           // скорость поворота влево/вправо

const POINTS_PER_10M = 1;      // очки за каждые 10 метров
const POINTS_PER_OVERTAKE = 50; // очки за обгон одной машины

// --- 3. Состояние игры ---
let state = "start"; // "start", "playing" или "gameover"
let distance = 0;    // пройдено метров
let overtakes = 0;   // сколько машин обогнали
let spawnTimer = 0;  // счётчик до появления новой машины
let currentUser = null; // вошедший игрок (или null)

// Машина игрока. x, y — левый верхний угол прямоугольника.
const player = {
  x: ROAD_LEFT + LANE_WIDTH * 1.5 - PLAYER_WIDTH / 2,
  y: HEIGHT - 120,
  width: PLAYER_WIDTH,
  height: PLAYER_HEIGHT,
  speed: 0,
};

// Машины соперников
let enemies = [];

// Какие клавиши сейчас нажаты
const keys = {};

// --- 4. Очки и работа с сервером ---

// Очки за текущую гонку
function getScore() {
  return Math.floor(distance / 10) * POINTS_PER_10M + overtakes * POINTS_PER_OVERTAKE;
}

// Небольшая обёртка над fetch: самостоятельно парсит JSON и показывает ошибку
async function apiRequest(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: options.body
      ? { "Content-Type": "application/json", ...(options.headers || {}) }
      : options.headers,
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Ошибка запроса");
  return data;
}

// Узнаём, кто вошёл в аккаунт (сервер смотрит cookie)
async function loadCurrentUser() {
  try {
    const data = await apiRequest("/api/me");
    currentUser = data.user;
  } catch (error) {
    currentUser = null;
  }
  updateAuthUI();
}

// Берём таблицу лучших результатов из базы данных
async function loadTopScores() {
  try {
    const data = await apiRequest("/api/scores");
    renderResults(data.scores);
  } catch (error) {
    resultsBody.innerHTML =
      '<tr><td colspan="5">Не удалось загрузить результаты</td></tr>';
  }
}

// Отправляем результат гонки на сервер. Доступно только вошедшим игрокам.
async function saveScoreToServer(score) {
  const data = await apiRequest("/api/scores", {
    method: "POST",
    body: JSON.stringify({
      score: score,
      distance: Math.floor(distance),
      overtakes: overtakes,
    }),
  });
  currentUser = data.user;
  updateAuthUI();
}

// Показываем/скрываем форму входа в зависимости от того, вошёл игрок или нет
function updateAuthUI() {
  if (currentUser) {
    authForm.hidden = true;
    userInfo.hidden = false;
    userName.textContent = currentUser.login;
    racesLabel.textContent = currentUser.races;
    userBestLabel.textContent = currentUser.bestScore;
    bestLabel.textContent = currentUser.bestScore;
  } else {
    authForm.hidden = false;
    userInfo.hidden = true;
    bestLabel.textContent = 0;
  }
}

// Рисуем таблицу результатов
function renderResults(scores) {
  resultsBody.innerHTML = "";

  if (!scores || scores.length === 0) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 5;
    cell.textContent = "Пока нет результатов — сыграйте первую гонку!";
    row.appendChild(cell);
    resultsBody.appendChild(row);
    return;
  }

  scores.forEach((item, index) => {
    const row = document.createElement("tr");
    const values = [index + 1, item.login, item.score, `${item.distance} м`, item.overtakes];

    values.forEach((value) => {
      const cell = document.createElement("td");
      cell.textContent = value;
      row.appendChild(cell);
    });

    resultsBody.appendChild(row);
  });
}

// --- 5. Управление и вход/регистрация ---

window.addEventListener("keydown", (event) => {
  keys[event.code] = true;

  // Не даём стрелкам прокручивать страницу
  if (event.code.startsWith("Arrow")) {
    event.preventDefault();
  }

  // Enter тоже может начать игру
  if (event.code === "Enter" && state !== "playing" && document.activeElement.tagName !== "INPUT") {
    startGame();
  }
});

window.addEventListener("keyup", (event) => {
  keys[event.code] = false;
});

startButton.addEventListener("click", startGame);

authForm.addEventListener("submit", (event) => {
  event.preventDefault();
  loginUser();
});

registerButton.addEventListener("click", registerUser);
logoutButton.addEventListener("click", logoutUser);

async function registerUser() {
  authStatus.textContent = "Регистрируем...";
  try {
    const data = await apiRequest("/api/register", {
      method: "POST",
      body: JSON.stringify({
        login: loginInput.value.trim(),
        password: passwordInput.value,
      }),
    });
    currentUser = data.user;
    updateAuthUI();
    authStatus.textContent = "Регистрация выполнена!";
    passwordInput.value = "";
    await loadTopScores();
  } catch (error) {
    authStatus.textContent = error.message;
  }
}

async function loginUser() {
  authStatus.textContent = "Проверяем...";
  try {
    const data = await apiRequest("/api/login", {
      method: "POST",
      body: JSON.stringify({
        login: loginInput.value.trim(),
        password: passwordInput.value,
      }),
    });
    currentUser = data.user;
    updateAuthUI();
    authStatus.textContent = `Привет, ${currentUser.login}!`;
    passwordInput.value = "";
    await loadTopScores();
  } catch (error) {
    authStatus.textContent = error.message;
  }
}

async function logoutUser() {
  try {
    await apiRequest("/api/logout", { method: "POST" });
    currentUser = null;
    updateAuthUI();
    authStatus.textContent = "Вы вышли из аккаунта";
  } catch (error) {
    authStatus.textContent = error.message;
  }
}

// --- 6. Начало и конец игры ---

function startGame() {
  player.x = ROAD_LEFT + LANE_WIDTH * 1.5 - PLAYER_WIDTH / 2;
  player.y = HEIGHT - 120;
  player.speed = 0;

  enemies = [];
  distance = 0;
  overtakes = 0;
  spawnTimer = 0;
  state = "playing";

  overlay.classList.add("hidden");
  updateLabels();
}

async function gameOver() {
  state = "gameover";

  const score = getScore();
  overlayTitle.textContent = "Машина разбита!";
  overlayText.innerHTML =
    `Вы проехали <b>${Math.floor(distance)} м</b>.<br>` +
    `Обгонов: <b>${overtakes}</b><br>` +
    `<b>Очки: ${score}</b><br>` +
    `<span class="small">Сохраняем результат...</span>`;
  startButton.textContent = "Ещё раз";
  overlay.classList.remove("hidden");

  let message;
  if (currentUser) {
    try {
      await saveScoreToServer(score);
      await loadTopScores();
      message = '<br><span class="small">Результат сохранён в базе данных!</span>';
    } catch (error) {
      message = '<br><span class="small">Не удалось сохранить результат.</span>';
    }
  } else {
    message = '<br><span class="small">Войдите в аккаунт, чтобы сохранить результат.</span>';
  }

  overlayText.innerHTML =
    `Вы проехали <b>${Math.floor(distance)} м</b>.<br>` +
    `Обгонов: <b>${overtakes}</b><br>` +
    `<b>Очки: ${score}</b>${message}<br>` +
    `Хотите попробовать ещё раз?`;
}

// --- 7. Обновление игры (вызывается каждый кадр) ---
function update() {
  if (state !== "playing") return;

  // Разгон, тормоз и естественное замедление
  if (keys.ArrowUp || keys.KeyW) {
    player.speed += ACCELERATION;
  } else if (keys.ArrowDown || keys.KeyS) {
    player.speed -= BRAKING;
  } else {
    player.speed -= FRICTION;
  }

  // Ограничиваем скорость от 0 до MAX_SPEED
  player.speed = Math.max(0, Math.min(MAX_SPEED, player.speed));

  // Поворот влево/вправо
  if (keys.ArrowLeft || keys.KeyA) {
    player.x -= STEERING;
  }
  if (keys.ArrowRight || keys.KeyD) {
    player.x += STEERING;
  }

  // Не даём машине выехать за дорогу
  player.x = Math.max(ROAD_LEFT + 4, Math.min(ROAD_RIGHT - PLAYER_WIDTH - 4, player.x));

  // Счётчик дистанции
  distance += player.speed * 0.5;

  // Появление новых машин. Чем дольше едем, тем они чаще.
  const spawnInterval = Math.max(35, 75 - distance / 200);
  spawnTimer++;

  if (spawnTimer >= spawnInterval) {
    spawnTimer = 0;
    spawnEnemy();
  }

  // Движение машин соперников и подсчёт обгонов
  for (const enemy of enemies) {
    // Машина игрока едет вверх, поэтому мир сдвигается вниз.
    // Чем быстрее игрок, тем быстрее соперники приближаются.
    enemy.y += player.speed - enemy.speed;

    // Как только машина оказалась позади игрока — это обгон (+50 очков)
    if (!enemy.passed && enemy.y > player.y + player.height) {
      enemy.passed = true;
      overtakes++;
    }
  }

  // Удаляем машины, которые уехали за нижний край экрана
  enemies = enemies.filter((enemy) => enemy.y < HEIGHT + 100);

  // Проверяем столкновения
  for (const enemy of enemies) {
    if (isColliding(player, enemy)) {
      gameOver();
      break;
    }
  }

  updateLabels();
}

function spawnEnemy() {
  // Выбираем случайную полосу (от 0 до LANE_COUNT - 1)
  const lane = Math.floor(Math.random() * LANE_COUNT);
  const width = 38;
  const height = 64;

  enemies.push({
    x: ROAD_LEFT + lane * LANE_WIDTH + (LANE_WIDTH - width) / 2,
    y: -100,
    width: width,
    height: height,
    speed: 1 + Math.random() * 1.5, // скорость соперника
    passed: false,                  // учтён ли обгон этой машины
    color: ["#e74c3c", "#f39c12", "#9b59b6", "#ecf0f1"][
      Math.floor(Math.random() * 4)
    ],
  });
}

// Проверка пересечения двух прямоугольников
function isColliding(a, b) {
  // Немного уменьшаем зону попадания, чтобы столкновения были «необидными»
  const pad = 6;
  return (
    a.x + pad < b.x + b.width - pad &&
    a.x + a.width - pad > b.x + pad &&
    a.y + pad < b.y + b.height - pad &&
    a.y + a.height - pad > b.y + pad
  );
}

function updateLabels() {
  distanceLabel.textContent = Math.floor(distance);
  speedLabel.textContent = Math.round(player.speed * 30);
  scoreLabel.textContent = getScore();
}

// --- 8. Отрисовка (рисуем каждый кадр) ---
function draw() {
  // Трава вокруг дороги
  ctx.fillStyle = "#4a9d5f";
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  // Дорога
  ctx.fillStyle = "#3d4450";
  ctx.fillRect(ROAD_LEFT, 0, ROAD_RIGHT - ROAD_LEFT, HEIGHT);

  // Полосы по краям дороги (красно-белый «бордюр»)
  const stripeSize = 30;
  const offset = Math.floor(distance) % (stripeSize * 2);
  for (let y = -stripeSize * 2 + offset; y < HEIGHT; y += stripeSize * 2) {
    ctx.fillStyle = "#e74c3c";
    ctx.fillRect(ROAD_LEFT - 8, y, 8, stripeSize);
    ctx.fillRect(ROAD_RIGHT, y, 8, stripeSize);

    ctx.fillStyle = "#ffffff";
    ctx.fillRect(ROAD_LEFT - 8, y + stripeSize, 8, stripeSize);
    ctx.fillRect(ROAD_RIGHT, y + stripeSize, 8, stripeSize);
  }

  // Белые пунктирные линии между полосами
  ctx.strokeStyle = "rgba(255, 255, 255, 0.6)";
  ctx.lineWidth = 3;
  ctx.setLineDash([25, 25]);
  ctx.lineDashOffset = -distance;

  for (let i = 1; i < LANE_COUNT; i++) {
    const x = ROAD_LEFT + i * LANE_WIDTH;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, HEIGHT);
    ctx.stroke();
  }
  ctx.setLineDash([]);

  // Машины соперников
  for (const enemy of enemies) {
    drawCar(enemy.x, enemy.y, enemy.width, enemy.height, enemy.color);
  }

  // Машина игрока
  drawCar(player.x, player.y, player.width, player.height, "#3498db");
}

// Рисуем одну машину: кузов, стёкла, колёса и фары
function drawCar(x, y, width, height, color) {
  // Колёса
  ctx.fillStyle = "#111111";
  ctx.fillRect(x - 4, y + 10, 6, 14);
  ctx.fillRect(x + width - 2, y + 10, 6, 14);
  ctx.fillRect(x - 4, y + height - 24, 6, 14);
  ctx.fillRect(x + width - 2, y + height - 24, 6, 14);

  // Кузов
  ctx.fillStyle = color;
  ctx.fillRect(x, y, width, height);

  // Лобовое стекло (сверху, потому что машина едет вверх)
  ctx.fillStyle = "#8fd3f4";
  ctx.fillRect(x + 6, y + 12, width - 12, 14);

  // Заднее стекло
  ctx.fillRect(x + 6, y + height - 24, width - 12, 10);

  // Фары
  ctx.fillStyle = "#fff3b0";
  ctx.fillRect(x + 5, y, 8, 4);
  ctx.fillRect(x + width - 13, y, 8, 4);
}

// --- 9. Главный цикл игры ---
function loop() {
  update();
  draw();
  requestAnimationFrame(loop);
}

// --- 10. Запуск ---
updateAuthUI();
loadCurrentUser();
loadTopScores();
draw();
loop();
