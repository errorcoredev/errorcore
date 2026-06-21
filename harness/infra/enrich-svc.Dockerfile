FROM node:20.11.1-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production

RUN apt-get update \
  && apt-get install -y --no-install-recommends libfaketime \
  && rm -rf /var/lib/apt/lists/*

COPY vendor/errorcore-0.2.0.tgz /errorcore-0.2.0.tgz
COPY apps/enrich-svc/package.json apps/enrich-svc/package-lock.json* ./

RUN npm install --ignore-scripts --omit=dev
RUN npm install --ignore-scripts --no-save esbuild@0.25.12

COPY apps/enrich-svc/errorcore-bootstrap.js ./errorcore-bootstrap.js
COPY apps/enrich-svc/server.js ./server.js

RUN npx esbuild@0.25.12 server.js --bundle --platform=node --target=node20 --minify --sourcemap=external --outfile=dist/server.js
RUN test -f dist/server.js.map
RUN node -e "const fs=require('fs');const lines=fs.readFileSync('dist/server.js','utf8').split(/\r?\n/);const long=lines.filter((line)=>line.length>500).length;if(long<1){process.exit(1)}"

EXPOSE 3001

CMD ["node", "--enable-source-maps", "--unhandled-rejections=strict", "dist/server.js"]
