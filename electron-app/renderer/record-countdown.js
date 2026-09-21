// 녹화할 화면 가운데의 세기. 창을 걷는 시각은 main이 정한다 — 여기 숫자는 보여 주기만 한다.
const params = new URLSearchParams(location.search);
const count = document.getElementById("count");
const label = params.get("label");
if (label) document.getElementById("label").textContent = `${label} · 정지하면 빨간 테두리가 사라집니다`;

let remaining = Math.max(1, Math.round(Number(params.get("seconds")) || 3));
function paint() {
  count.textContent = String(remaining);
  count.classList.remove("tick");
  void count.offsetWidth;
  count.classList.add("tick");
}

paint();
const timer = setInterval(() => {
  remaining -= 1;
  if (remaining < 1) return clearInterval(timer);
  paint();
}, 1000);
