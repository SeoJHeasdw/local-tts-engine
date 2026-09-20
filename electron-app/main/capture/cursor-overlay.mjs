// 촬영 화면에 커서와 클릭 표시를 그린다. CDP 스크린캐스트는 페이지 내용만 담아
// OS 커서가 찍히지 않는다. 그래서 앱 데모에는 보이는 커서가 필요하다.
//
// 그리는 자리는 우리가 보낸 좌표다. 페이지의 mousemove를 따라 그리면 창 위에
// 놓여 있던 **실제 마우스**의 자리로 끌려간다(2026-09-20 RICE 파일럿에서 화살표가
// 입력창 대신 엉뚱한 빈 공간에 찍혔다). 조작은 여전히 진짜 마우스 사건으로 보내므로
// hover는 그대로 일어나고, 그림만 우리가 아는 좌표를 따른다.
function overlaySource() {
  return () => {
    if (window.__appDemoCursor) return;
    const install = () => {
      if (!document.body || document.getElementById("app-demo-cursor")) return;
      const style = document.createElement("style");
      style.textContent = `
        #app-demo-cursor {
          position: fixed; left: 0; top: 0; width: 0; height: 0;
          pointer-events: none; z-index: 2147483647;
        }
        #app-demo-cursor .point {
          position: absolute; left: 0; top: 0; width: 28px; height: 28px;
          transform: translate(-9999px, -9999px);
          will-change: transform; filter: drop-shadow(0 2px 4px rgba(0,0,0,.45));
        }
        #app-demo-cursor .ring {
          position: absolute; left: 0; top: 0; width: 84px; height: 84px; margin: -42px 0 0 -42px;
          border-radius: 50%; border: 3px solid rgba(90, 140, 255, .95);
          background: rgba(90, 140, 255, .18);
          transform: translate(-9999px, -9999px) scale(.2); opacity: 0;
        }
        #app-demo-cursor .ring[data-on="true"] { animation: app-demo-tap 420ms ease-out forwards; }
        @keyframes app-demo-tap {
          from { opacity: .95; transform: var(--at) scale(.18); }
          to   { opacity: 0;   transform: var(--at) scale(1); }
        }
      `;
      document.head.appendChild(style);

      const layer = document.createElement("div");
      layer.id = "app-demo-cursor";
      layer.setAttribute("aria-hidden", "true");
      // macOS 화살표를 닮은 모양. 흰 테두리가 어두운 화면에서도 보이게 한다.
      layer.innerHTML = `
        <div class="ring"></div>
        <svg class="point" viewBox="0 0 28 28" xmlns="http://www.w3.org/2000/svg">
          <path d="M6 3.2 L6 22.4 L10.8 17.8 L13.8 24.6 L17.2 23.1 L14.2 16.4 L20.8 16.1 Z"
                fill="#101216" stroke="#ffffff" stroke-width="1.6" stroke-linejoin="round"/>
        </svg>`;
      document.body.appendChild(layer);

      const point = layer.querySelector(".point");
      const ring = layer.querySelector(".ring");
      let at = "translate(-9999px, -9999px)";
      window.__appDemoCursor = {
        place(x, y) {
          at = `translate(${x}px, ${y}px)`;
          point.style.transform = at;
        },
        tap() {
          ring.style.setProperty("--at", at);
          ring.dataset.on = "false";
          // 애니메이션을 다시 트는 유일한 방법은 되돌리기를 한 번 강제하는 것이다.
          void ring.offsetWidth;
          ring.dataset.on = "true";
        },
      };
    };
    if (document.body) install();
    else addEventListener("DOMContentLoaded", install, { once: true });
  };
}

/**
 * 커서 표시를 페이지에 넣는다.
 *
 * 지금 열려 있는 문서와 앞으로 열릴 문서 모두에 넣는다. 앱이 촬영 도중 화면을
 * 갈아 끼워도 커서가 사라지지 않는다.
 */
export async function installCursorOverlay(page) {
  await page.addInitScript(overlaySource());
  await page.evaluate(overlaySource());
}

// 커서를 옮긴다. 실제 마우스도 같이 움직여 hover가 진짜로 일어나게 한다.
export async function moveCursor(page, x, y) {
  await page.mouse.move(x, y);
  await page.evaluate(([px, py]) => window.__appDemoCursor?.place(px, py), [x, y]).catch(() => {});
}

export async function showTap(page) {
  await page.evaluate(() => window.__appDemoCursor?.tap()).catch(() => {});
}

// 사람 손의 움직임. 가속하고 감속하며, 프레임마다 한 점씩 옮긴다. 한 번에 뛰면
// 커서가 순간이동하고 클릭 지점 확대가 어디서 왔는지 알 수 없다.
export function glidePath(from, to, { steps = 18 } = {}) {
  const path = [];
  for (let step = 1; step <= steps; step++) {
    const ratio = (1 - Math.cos(Math.PI * step / steps)) / 2;
    path.push({ x: from.x + (to.x - from.x) * ratio, y: from.y + (to.y - from.y) * ratio });
  }
  return path;
}
