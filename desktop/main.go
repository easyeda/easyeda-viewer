// EasyEDA Viewer Desktop — a single install-free executable that loads the
// embedded single-file viewer (dist/index.html) in a native webview window and
// exposes native open dialogs + local file reading to the page.
//
// Pattern follows freerouting-desktop: //go:embed dist -> 127.0.0.1 HTTP
// server -> webview window -> JS bindings (openFileDialog / openFolderDialog /
// readProjectFiles). The frontend detects the bindings and uses them in place
// of <input type=file> pickers (see src/ui/dnd.ts desktopBridge).
package main

import (
	"embed"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"runtime/debug"
	"strconv"
	"syscall"
	"time"

	webview "github.com/webview/webview_go"
)

//go:embed all:dist
var dist embed.FS

var (
	version  = "dev"
	platform = "dev"
)

// wv is the active webview instance, used by the Windows window watcher to
// terminate the message loop when the user closes the window.
var wv webview.WebView

func main() {
	log.SetFlags(log.Ltime)
	defer func() {
		if r := recover(); r != nil {
			log.Printf("PANIC: %v\n%s", r, debug.Stack())
		}
	}()
	start := time.Now()
	stage := func(name string) {
		log.Printf("[t+%v] %s", time.Since(start).Round(time.Millisecond), name)
	}
	log.Printf("EasyEDA Viewer Desktop %s (%s)", version, platform)

	// WebView2 is the rendering engine — without it the window would stay blank,
	// so detect the runtime up front and offer the official download (#18). The
	// user installs it, then re-runs the exe.
	if !webView2Available() {
		log.Printf("WebView2 runtime not found — prompting for download")
		promptWebView2Download()
		return
	}
	prepareWebView2Env()

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-sigCh
		os.Exit(0)
	}()

	sub, err := fs.Sub(dist, "dist")
	if err != nil {
		log.Printf("FATAL: embed error: %v", err)
		return
	}
	mux := http.NewServeMux()
	mux.Handle("/", noCache(http.FileServer(http.FS(sub))))

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		log.Printf("FATAL: cannot bind localhost: %v", err)
		return
	}
	port := ln.Addr().(*net.TCPAddr).Port
	go http.Serve(ln, mux)
	url := "http://127.0.0.1:" + strconv.Itoa(port) + "/?v=" + version
	stage("local server ready " + url)

	winW, winH := initialWindowSize()
	hostWnd := createHostWindow(winW, winH)
	stage("host window shown (webview env init starts here)")
	w := webview.NewWindow(false, hostWnd)
	wv = w
	defer w.Destroy()
	stage("webview environment + controller ready")

	w.SetTitle("EasyEDA 查看器 - v" + version)
	w.SetSize(winW, winH, webview.HintNone)
	prepareWindow(w.Window(), winW, winH)
	stage("navigating to " + url)

	w.Bind("openFileDialog", openFileDialog)
	w.Bind("openFolderDialog", openFolderDialog)
	w.Bind("readProjectFiles", readProjectFilesJSON)
	w.Bind("getAppVersion", func() string { return version })

	w.Navigate(url)
	w.Run()
	log.Println("exited")
}

func noCache(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		h.ServeHTTP(w, r)
	})
}
