# Resizify web interface

The SolidJS frontend for Resizify.

```sh
npm install
npm run dev
```

The development server runs at http://localhost:3000 and proxies API requests to the Go server at http://localhost:8080.

Create the production assets with:

```sh
npm run build
```

The Go application embeds the contents of the root `web` directory. After building, copy `dist` to `../web` before compiling the Go application.
