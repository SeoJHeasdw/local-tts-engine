// 촬영용 정적 사이트 서버. 제작 시작 시 고정한 사이트만 전용 포트로 제공한다.
// 작업 트리의 Vite 개발 서버와 분리되므로 촬영 중 다른 챕터를 저장해도 녹화
// 화면이 HMR로 새로고침되거나 상태 채널이 섞이지 않는다.
import fs from "node:fs";
import path from "node:path";
import { createServer } from "node:http";

const MIME_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".js", "text/javascript; charset=utf-8"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".json", "application/json; charset=utf-8"],
  [".m4a", "audio/mp4"],
  [".map", "application/json; charset=utf-8"],
  [".mp3", "audio/mpeg"],
  [".mp4", "video/mp4"],
  [".otf", "font/otf"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".ttf", "font/ttf"],
  [".wav", "audio/wav"],
  [".webm", "video/webm"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

export function startCaptureServer(siteDir) {
  const root = path.resolve(siteDir);
  const indexFile = path.join(root, "index.html");
  if (!fs.existsSync(indexFile)) {
    throw new Error(`캡처 화면 스냅샷에 index.html이 없습니다: ${root}`);
  }
  const server = createServer((request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url || "/", "http://127.0.0.1").pathname);
      const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
      let file = path.resolve(root, relative);
      if (file !== root && !file.startsWith(`${root}${path.sep}`)) {
        response.writeHead(403).end("Forbidden");
        return;
      }
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) file = indexFile;
      const stat = fs.statSync(file);
      const headers = {
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store",
        "Content-Type": MIME_TYPES.get(path.extname(file).toLowerCase()) || "application/octet-stream",
      };
      const range = request.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
      if (range) {
        const start = Number(range[1]);
        const end = range[2] ? Math.min(Number(range[2]), stat.size - 1) : stat.size - 1;
        if (start > end || start >= stat.size) {
          response.writeHead(416, { "Content-Range": `bytes */${stat.size}` }).end();
          return;
        }
        response.writeHead(206, {
          ...headers,
          "Content-Length": end - start + 1,
          "Content-Range": `bytes ${start}-${end}/${stat.size}`,
        });
        if (request.method === "HEAD") response.end();
        else fs.createReadStream(file, { start, end }).pipe(response);
        return;
      }
      response.writeHead(200, { ...headers, "Content-Length": stat.size });
      if (request.method === "HEAD") response.end();
      else fs.createReadStream(file).pipe(response);
    } catch (error) {
      response.writeHead(500).end(error.message);
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      if (!port) {
        server.close();
        reject(new Error("캡처 서버용 포트를 찾지 못했습니다."));
        return;
      }
      resolve({ server, port });
    });
  });
}

export async function waitForServer(url) {
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // 아직 시작 중
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("캡처 화면 서버가 20초 안에 준비되지 않았습니다.");
}
