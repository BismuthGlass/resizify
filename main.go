package main

import (
	"crypto/rand"
	"embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"log"
	"mime"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

//go:embed all:resizify-webapp/dist
var distFiles embed.FS

type imageInfo struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Width    int    `json:"width"`
	Height   int    `json:"height"`
	URL      string `json:"url"`
	Path     string `json:"-"`
	MimeType string `json:"-"`
}

type app struct {
	mu      sync.RWMutex
	images  map[string]imageInfo
	tempDir string
	outDir  string
}

type saveRequest struct {
	ID     string  `json:"id"`
	X      float64 `json:"x"`
	Y      float64 `json:"y"`
	Width  float64 `json:"width"`
	Height float64 `json:"height"`
}

type outputInfo struct {
	Name    string    `json:"name"`
	URL     string    `json:"url"`
	Created time.Time `json:"created"`
	Width   int       `json:"width"`
	Height  int       `json:"height"`
	Path    string    `json:"-"`
}

func main() {
	port := flag.Int("port", 0, "HTTP port (overrides RESIZIFY_ADDR)")
	openBrowser := flag.Bool("open", false, "open the application in the default browser")
	flag.Parse()
	if *port < 0 || *port > 65535 {
		log.Fatal("port must be between 1 and 65535")
	}

	tempDir, err := os.MkdirTemp("", "resizify-")
	if err != nil {
		log.Fatal(err)
	}
	defer os.RemoveAll(tempDir)

	outDir := os.Getenv("RESIZIFY_OUTPUT_DIR")
	if outDir == "" {
		outDir = "output"
	}
	if err := os.MkdirAll(outDir, 0755); err != nil {
		log.Fatal(err)
	}
	outDir, _ = filepath.Abs(outDir)

	a := &app{images: make(map[string]imageInfo), tempDir: tempDir, outDir: outDir}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/upload", a.upload)
	mux.HandleFunc("GET /api/images/{id}", a.image)
	mux.HandleFunc("POST /api/save", a.save)
	mux.HandleFunc("GET /api/outputs", a.outputs)
	mux.HandleFunc("GET /api/outputs/{name}", a.outputImage)
	mux.HandleFunc("POST /api/open-output", a.openOutput)
	mux.HandleFunc("DELETE /api/images/{id}", a.remove)

	dist, err := fs.Sub(distFiles, "resizify-webapp/dist")
	if err != nil {
		log.Fatal(err)
	}
	mux.Handle("/", spaHandler(dist))

	addr := os.Getenv("RESIZIFY_ADDR")
	if *port > 0 {
		addr = fmt.Sprintf(":%d", *port)
	} else if addr == "" {
		addr = ":8080"
	}
	listener, err := net.Listen("tcp", addr)
	if err != nil {
		log.Fatal(err)
	}
	url := browserURL(addr)
	log.Printf("Resizify listening on %s (output: %s)", url, outDir)
	if *openBrowser {
		go func() {
			time.Sleep(100 * time.Millisecond)
			if err := openTarget(url); err != nil {
				log.Printf("Could not open browser: %v", err)
			}
		}()
	}
	log.Fatal(http.Serve(listener, logging(mux)))
}

func (a *app) upload(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 100<<20)
	if err := r.ParseMultipartForm(100 << 20); err != nil {
		fail(w, "Image is too large or invalid", 400)
		return
	}
	defer r.MultipartForm.RemoveAll()
	file, header, err := r.FormFile("image")
	if err != nil {
		fail(w, "Choose an image to upload", 400)
		return
	}
	defer file.Close()

	id := randomID()
	ext := strings.ToLower(filepath.Ext(header.Filename))
	if ext == "" || len(ext) > 6 {
		ext = ".img"
	}
	path := filepath.Join(a.tempDir, id+ext)
	out, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		fail(w, "Could not store image", 500)
		return
	}
	_, copyErr := io.Copy(out, file)
	closeErr := out.Close()
	if copyErr != nil || closeErr != nil {
		os.Remove(path)
		fail(w, "Could not store image", 500)
		return
	}

	width, height, format, err := identify(path)
	if err != nil || width < 1 || height < 1 {
		os.Remove(path)
		fail(w, "Unsupported or invalid image", 400)
		return
	}
	info := imageInfo{ID: id, Name: filepath.Base(header.Filename), Width: width, Height: height, URL: "/api/images/" + id, Path: path, MimeType: mime.TypeByExtension("." + strings.ToLower(format))}
	if info.MimeType == "" {
		info.MimeType = http.DetectContentType(mustPrefix(path))
	}
	a.mu.Lock()
	a.images[id] = info
	a.mu.Unlock()
	writeJSON(w, info)
}

func (a *app) image(w http.ResponseWriter, r *http.Request) {
	info, ok := a.get(r.PathValue("id"))
	if !ok {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", info.MimeType)
	w.Header().Set("Cache-Control", "private, max-age=3600")
	http.ServeFile(w, r, info.Path)
}

func (a *app) remove(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	a.mu.Lock()
	info, ok := a.images[id]
	delete(a.images, id)
	a.mu.Unlock()
	if ok {
		os.Remove(info.Path)
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *app) save(w http.ResponseWriter, r *http.Request) {
	var req saveRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil {
		fail(w, "Invalid crop data", 400)
		return
	}
	info, ok := a.get(req.ID)
	if !ok {
		fail(w, "Image has expired; upload it again", 404)
		return
	}
	if req.Width < 1 || req.Height < 1 || req.Width > 20000 || req.Height > 20000 || req.Width*req.Height > 100000000 || req.X < -20000 || req.Y < -20000 || req.X > 20000 || req.Y > 20000 {
		fail(w, "Invalid frame size", 400)
		return
	}

	x, y := intRound(req.X), intRound(req.Y)
	width, height := max(1, intRound(req.Width)), max(1, intRound(req.Height))
	base := strings.TrimSuffix(filepath.Base(info.Name), filepath.Ext(info.Name))
	base = safeName(base)
	if base == "" {
		base = "image"
	}
	ext := strings.ToLower(filepath.Ext(info.Name))
	if ext != ".jpg" && ext != ".jpeg" && ext != ".png" && ext != ".webp" {
		ext = ".png"
	}
	name := fmt.Sprintf("%s_%dx%d_%s%s", base, width, height, time.Now().Format("20060102-150405"), ext)
	output := uniquePath(a.outDir, name)

	background := "white"
	geometry := fmt.Sprintf("%dx%d%+d%+d!", width, height, x, y)
	cmd := exec.Command("magick", info.Path+"[0]", "-auto-orient", "+repage", "-crop", geometry, "-background", background, "-flatten", "+repage", output)
	if data, err := cmd.CombinedOutput(); err != nil {
		log.Printf("magick: %v: %s", err, data)
		fail(w, "ImageMagick could not save the image", 500)
		return
	}
	outputName := filepath.Base(output)
	writeJSON(w, map[string]string{"name": outputName, "path": output, "url": "/api/outputs/" + url.PathEscape(outputName)})
}

func (a *app) outputs(w http.ResponseWriter, _ *http.Request) {
	entries, err := os.ReadDir(a.outDir)
	if err != nil {
		fail(w, "Could not read the output directory", 500)
		return
	}
	items := make([]outputInfo, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() || !isOutputImage(entry.Name()) {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		items = append(items, outputInfo{Name: entry.Name(), URL: "/api/outputs/" + url.PathEscape(entry.Name()), Created: info.ModTime(), Path: filepath.Join(a.outDir, entry.Name())})
	}
	sort.Slice(items, func(i, j int) bool { return items[i].Created.After(items[j].Created) })
	if len(items) > 12 {
		items = items[:12]
	}
	for i := range items {
		items[i].Width, items[i].Height, _, _ = identify(items[i].Path)
	}
	writeJSON(w, items)
}

func (a *app) outputImage(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	if name == "" || filepath.Base(name) != name || !isOutputImage(name) {
		http.NotFound(w, r)
		return
	}
	path := filepath.Join(a.outDir, name)
	if info, err := os.Stat(path); err != nil || info.IsDir() {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", mime.TypeByExtension(strings.ToLower(filepath.Ext(name))))
	w.Header().Set("Cache-Control", "private, max-age=3600")
	http.ServeFile(w, r, path)
}

func isOutputImage(name string) bool {
	switch strings.ToLower(filepath.Ext(name)) {
	case ".jpg", ".jpeg", ".png", ".webp":
		return true
	default:
		return false
	}
}

func (a *app) openOutput(w http.ResponseWriter, _ *http.Request) {
	if err := openTarget(a.outDir); err != nil {
		fail(w, "Could not open the output directory", 500)
		return
	}
	writeJSON(w, map[string]string{"path": a.outDir})
}

func openTarget(target string) error {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", target)
	case "windows":
		cmd = exec.Command("cmd", "/c", "start", "", target)
	default:
		cmd = exec.Command("xdg-open", target)
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	go cmd.Wait()
	return nil
}

func browserURL(addr string) string {
	if strings.HasPrefix(addr, ":") {
		return "http://localhost" + addr
	}
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return "http://" + addr
	}
	if host == "" || host == "0.0.0.0" || host == "::" {
		host = "localhost"
	}
	return "http://" + net.JoinHostPort(host, port)
}

func identify(path string) (int, int, string, error) {
	data, err := exec.Command("magick", path+"[0]", "-auto-orient", "-format", "%[width] %[height] %[magick]", "info:").Output()
	if err != nil {
		return 0, 0, "", err
	}
	parts := strings.Fields(string(data))
	if len(parts) != 3 {
		return 0, 0, "", errors.New("unexpected identify output")
	}
	w, e1 := strconv.Atoi(parts[0])
	h, e2 := strconv.Atoi(parts[1])
	if e1 != nil || e2 != nil {
		return 0, 0, "", errors.New("invalid dimensions")
	}
	return w, h, parts[2], nil
}

func (a *app) get(id string) (imageInfo, bool) {
	a.mu.RLock()
	defer a.mu.RUnlock()
	v, ok := a.images[id]
	return v, ok
}
func intRound(v float64) int {
	if v < 0 {
		return int(v - .5)
	}
	return int(v + .5)
}
func randomID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}
func safeName(s string) string {
	return strings.Trim(strings.Map(func(r rune) rune {
		if r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-' || r == '_' {
			return r
		}
		if r == ' ' {
			return '-'
		}
		return -1
	}, s), "-_")
}
func uniquePath(dir, name string) string {
	p := filepath.Join(dir, name)
	if _, err := os.Stat(p); os.IsNotExist(err) {
		return p
	}
	ext := filepath.Ext(name)
	stem := strings.TrimSuffix(name, ext)
	for i := 2; ; i++ {
		p = filepath.Join(dir, fmt.Sprintf("%s-%d%s", stem, i, ext))
		if _, err := os.Stat(p); os.IsNotExist(err) {
			return p
		}
	}
}
func mustPrefix(path string) []byte {
	f, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer f.Close()
	b := make([]byte, 512)
	n, _ := f.Read(b)
	return b[:n]
}
func writeJSON(w http.ResponseWriter, value any) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(value)
}
func fail(w http.ResponseWriter, message string, status int) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]string{"error": message})
}

func spaHandler(files fs.FS) http.Handler {
	server := http.FileServer(http.FS(files))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := strings.TrimPrefix(r.URL.Path, "/")
		if path != "" {
			if _, err := fs.Stat(files, path); err == nil {
				server.ServeHTTP(w, r)
				return
			}
		}
		r.URL.Path = "/"
		server.ServeHTTP(w, r)
	})
}
func logging(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		log.Printf("%s %s", r.Method, r.URL.Path)
		next.ServeHTTP(w, r)
	})
}
