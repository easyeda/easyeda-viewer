//go:build windows

package main

import (
	"fmt"
	"log"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

var (
	user32               = syscall.NewLazyDLL("user32.dll")
	kernel32             = syscall.NewLazyDLL("kernel32.dll")
	ole32                = syscall.NewLazyDLL("ole32.dll")
	comdlg32             = syscall.NewLazyDLL("comdlg32.dll")
	procCoInitializeEx   = ole32.NewProc("CoInitializeEx")
	procCoCreateInstance = ole32.NewProc("CoCreateInstance")
	procCoTaskMemFree    = ole32.NewProc("CoTaskMemFree")
	procGetOpenFileNameW = comdlg32.NewProc("GetOpenFileNameW")

	procRegisterClassExW         = user32.NewProc("RegisterClassExW")
	procCreateWindowExW          = user32.NewProc("CreateWindowExW")
	procDefWindowProcW           = user32.NewProc("DefWindowProcW")
	procLoadCursorW              = user32.NewProc("LoadCursorW")
	procFindWindowExW            = user32.NewProc("FindWindowExW")
	procGetClientRect            = user32.NewProc("GetClientRect")
	procSetWindowPos             = user32.NewProc("SetWindowPos")
	procGetWindowRect            = user32.NewProc("GetWindowRect")
	procGetSystemMetrics         = user32.NewProc("GetSystemMetrics")
	procSendMessageW             = user32.NewProc("SendMessageW")
	procLoadImageW               = user32.NewProc("LoadImageW")
	procShowWindow               = user32.NewProc("ShowWindow")
	procSetForegroundWindow      = user32.NewProc("SetForegroundWindow")
	procBringWindowToTop         = user32.NewProc("BringWindowToTop")
	procSetThreadDpiAwarenessCtx = user32.NewProc("SetThreadDpiAwarenessContext")
	procIsWindow                 = user32.NewProc("IsWindow")
	procIsIconic                 = user32.NewProc("IsIconic")
	procMessageBoxW              = user32.NewProc("MessageBoxW")
	procGetModuleHandleW         = kernel32.NewProc("GetModuleHandleW")

	gdi32                = syscall.NewLazyDLL("gdi32.dll")
	shell32              = syscall.NewLazyDLL("shell32.dll")
	advapi32             = syscall.NewLazyDLL("advapi32.dll")
	procCreateSolidBrush = gdi32.NewProc("CreateSolidBrush")
	procGetDpiForWindow  = user32.NewProc("GetDpiForWindow")
	procShellExecuteW    = shell32.NewProc("ShellExecuteW")
	procRegOpenKeyExW    = advapi32.NewProc("RegOpenKeyExW")
	procRegQueryValueExW = advapi32.NewProc("RegQueryValueExW")
	procRegCloseKey      = advapi32.NewProc("RegCloseKey")
)

// mainHwnd is the top-level window handed to WebView2. It starts hidden so the
// page never flashes a default-size window before SetSize/centering.
var mainHwnd uintptr

const (
	wmSetIcon               = 0x0080
	iconSmall               = 0
	iconBig                 = 1
	imageIcon               = 1
	lrDPISize               = 0x0040 // LR_DEFAULTSIZE
	lrShared                = 0x8000 // LR_SHARED
	swHide                  = 0
	swShow                  = 5
	wsOverlappedWindow      = 0x00CF0000
	cwUseDefault            = 0x80000000
	swpNoSize               = 0x0001
	swpNoZOrder             = 0x0004
	swpNoActivate           = 0x0010
	swpShowWindow           = 0x0040
	coInitApartmentThreaded = 0x2

	// Common Item Dialog (Vista+) for modern folder picker
	clsctxInprocServer    = 1
	fosPickFolders        = 0x00000020
	sigdnFileSysPath      = 0x80058000
	hresultErrorCancelled = 0x800704C7
)

func init() {
	// WebView2/COM requires the creating thread to stay on one OS thread.
	runtime.LockOSThread()
}

func init() {
	// Native dialogs must run on this same STA thread; webview Bind callbacks
	// execute on the message-loop thread (freerouting-desktop pattern).
	openFileNative = openFileDialogWindows
	openFolderNative = openFolderDialogWindows
}

func initialWindowSize() (int, int) {
	sw, sh := screenSize()
	return int(float64(sw) * 0.82), int(float64(sh) * 0.82)
}

func screenSize() (int, int) {
	sw, _, _ := procGetSystemMetrics.Call(0) // SM_CXSCREEN
	sh, _, _ := procGetSystemMetrics.Call(1) // SM_CYSCREEN
	return int(sw), int(sh)
}

type wndClassExW struct {
	cbSize        uint32
	style         uint32
	lpfnWndProc   uintptr
	cbClsExtra    int32
	cbWndExtra    int32
	hInstance     uintptr
	hIcon         uintptr
	hCursor       uintptr
	hbrBackground uintptr
	lpszMenuName  *uint16
	lpszClassName *uint16
	hIconSm       uintptr
}

type winRect struct {
	left, top, right, bottom int32
}

// hostBgColor is the pre-webview window background (COLORREF 0x00BBGGRR),
// matching the shell's --ev-bg so the early-shown frame blends into the UI.
const hostBgColor = 0x00F3F0EE

func createHostWindow(width, height int) unsafe.Pointer {
	procCoInitializeEx.Call(0, uintptr(coInitApartmentThreaded))
	procSetThreadDpiAwarenessCtx.Call(^uintptr(3)) // PER_MONITOR_AWARE_V3

	hInstance, _, _ := procGetModuleHandleW.Call(0)
	className, _ := syscall.UTF16PtrFromString("eextViewerParent")
	title, _ := syscall.UTF16PtrFromString("EasyEDA 查看器 - v" + version)

	bg, _, _ := procCreateSolidBrush.Call(hostBgColor)
	wc := wndClassExW{
		cbSize:        uint32(unsafe.Sizeof(wndClassExW{})),
		lpfnWndProc:   procDefWindowProcW.Addr(),
		hInstance:     hInstance,
		hIcon:         loadAppIcon(hInstance),
		hCursor:       loadArrowCursor(),
		hbrBackground: bg,
		lpszClassName: className,
	}
	wc.hIconSm = wc.hIcon

	if atom, _, err := procRegisterClassExW.Call(uintptr(unsafe.Pointer(&wc))); atom == 0 {
		log.Printf("[host] RegisterClassExW: %v", err)
		return nil
	}
	hwnd, _, err := procCreateWindowExW.Call(
		0, uintptr(unsafe.Pointer(className)), uintptr(unsafe.Pointer(title)),
		uintptr(wsOverlappedWindow), uintptr(cwUseDefault), uintptr(cwUseDefault),
		0, 0, 0, 0, hInstance, 0)
	if hwnd == 0 {
		log.Printf("[host] CreateWindowExW: %v", err)
		return nil
	}
	mainHwnd = hwnd
	// show immediately at final size — WebView2 environment creation inside
	// webview.NewWindow blocks for seconds on cold starts, and an empty app
	// frame beats a frozen taskbar while the renderer spins up (#19)
	sizeAndShowHost(hwnd, width, height)
	return unsafe.Pointer(hwnd)
}

// sizeAndShowHost applies the DPI-scaled final size, centers and shows the
// window before webview.NewWindow runs. w.SetSize in main.go re-applies the
// same scale afterwards, so on matching DPI the visible frame never moves.
func sizeAndShowHost(hwnd uintptr, width, height int) {
	dpi, _, _ := procGetDpiForWindow.Call(hwnd)
	if dpi == 0 {
		dpi = 96
	}
	w := uintptr(int64(width) * int64(dpi) / 96)
	h := uintptr(int64(height) * int64(dpi) / 96)
	procSetWindowPos.Call(hwnd, 0, 0, 0, w, h, swpNoZOrder|swpNoActivate)
	centerWindow(hwnd)
	procShowWindow.Call(hwnd, uintptr(swShow))
}

// prepareWebView2Env pins the WebView2 profile to %LOCALAPPDATA% and trims
// first-run browser work before the environment is created. The WebView2
// loader reads these WEBVIEW2_* env vars itself, so no library API is needed.
// A stable profile folder means warm starts skip re-provisioning and keeps
// defenders from re-scanning a profile that sits next to the exe (the loader
// default), which made cold starts noticeably slower.
func prepareWebView2Env() {
	if os.Getenv("WEBVIEW2_USER_DATA_FOLDER") == "" {
		if base := os.Getenv("LOCALAPPDATA"); base != "" {
			dir := filepath.Join(base, "EasyEDAViewer", "WebView2")
			if err := os.MkdirAll(dir, 0o755); err == nil {
				os.Setenv("WEBVIEW2_USER_DATA_FOLDER", dir)
			}
		}
	}
	if os.Getenv("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS") == "" {
		os.Setenv("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
			"--no-first-run --no-default-browser-check --disable-background-networking")
	}
}

func loadAppIcon(hInstance uintptr) uintptr {
	name, _ := syscall.UTF16PtrFromString("#1")
	hIcon, _, _ := procLoadImageW.Call(hInstance, uintptr(unsafe.Pointer(name)),
		uintptr(imageIcon), 0, 0, uintptr(lrDPISize|lrShared))
	return hIcon
}

func loadArrowCursor() uintptr {
	ret, _, _ := procLoadCursorW.Call(0, uintptr(32512)) // IDC_ARROW
	return ret
}

func prepareWindow(win unsafe.Pointer, width, height int) {
	hwnd := uintptr(win)
	if hwnd == 0 {
		return
	}
	mainHwnd = hwnd
	setWindowIcon(hwnd)
	centerWindow(hwnd)
	resizeWebviewWidget(hwnd)
	procShowWindow.Call(hwnd, uintptr(swShow))
	procSetForegroundWindow.Call(hwnd)
	procBringWindowToTop.Call(hwnd)
	startWindowWatcher(hwnd)
}

// startWindowWatcher keeps the webview widget in sync with user resizes and
// terminates the message loop when the window is destroyed.
func startWindowWatcher(hwnd uintptr) {
	go func() {
		var last winRect
		for {
			time.Sleep(100 * time.Millisecond)
			if exists, _, _ := procIsWindow.Call(hwnd); exists == 0 {
				if wv != nil {
					wv.Dispatch(func() { wv.Terminate() })
				}
				return
			}
			var r winRect
			procGetWindowRect.Call(hwnd, uintptr(unsafe.Pointer(&r)))
			if r != last {
				last = r
				if iconic, _, _ := procIsIconic.Call(hwnd); iconic == 0 {
					resizeWebviewWidget(hwnd)
				}
			}
		}
	}()
}

func centerWindow(hwnd uintptr) {
	sw, _, _ := procGetSystemMetrics.Call(0)
	sh, _, _ := procGetSystemMetrics.Call(1)
	var r winRect
	procGetWindowRect.Call(hwnd, uintptr(unsafe.Pointer(&r)))
	x := int(sw)/2 - int(r.right-r.left)/2
	y := int(sh)/2 - int(r.bottom-r.top)/2
	if x < 0 {
		x = 0
	}
	if y < 0 {
		y = 0
	}
	procSetWindowPos.Call(hwnd, 0, uintptr(x), uintptr(y), 0, 0, swpNoZOrder|swpNoActivate|swpNoSize)
}

func resizeWebviewWidget(parentHwnd uintptr) {
	className, _ := syscall.UTF16PtrFromString("webview_widget")
	widget, _, _ := procFindWindowExW.Call(parentHwnd, 0, uintptr(unsafe.Pointer(className)), 0)
	if widget == 0 {
		return
	}
	var r winRect
	procGetClientRect.Call(parentHwnd, uintptr(unsafe.Pointer(&r)))
	procSetWindowPos.Call(widget, 0, 0, 0, uintptr(r.right-r.left), uintptr(r.bottom-r.top),
		swpNoZOrder|swpNoActivate|swpShowWindow)
}

func setWindowIcon(hwnd uintptr) {
	hInstance, _, _ := procGetModuleHandleW.Call(0)
	hIcon := loadAppIcon(hInstance)
	if hIcon == 0 {
		return
	}
	procSendMessageW.Call(hwnd, uintptr(wmSetIcon), uintptr(iconSmall), hIcon)
	procSendMessageW.Call(hwnd, uintptr(wmSetIcon), uintptr(iconBig), hIcon)
}

// ---------- WebView2 runtime detection & download prompt (#18) ----------

// webView2RuntimeCLSID is the Evergreen WebView2 Runtime's client id under the
// EdgeUpdate\Clients registry keys (official detection recipe).
const webView2RuntimeCLSID = "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"

const (
	hKeyLocalMachine = 0x80000002
	hKeyCurrentUser  = 0x80000001
	keyRead          = 0x20019
	rrtRegSz         = 1
)

// webView2Available reports whether the WebView2 Evergreen runtime is
// installed: any of the EdgeUpdate\Clients\<CLSID> keys (HKLM system-wide,
// WOW6432Node for 32-bit EdgeUpdate writers, HKCU per-user) carrying a
// non-empty pv value means the runtime is there.
func webView2Available() bool {
	for _, k := range []struct {
		root uintptr
		path string
	}{
		{hKeyLocalMachine, `SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\` + webView2RuntimeCLSID},
		{hKeyLocalMachine, `SOFTWARE\Microsoft\EdgeUpdate\Clients\` + webView2RuntimeCLSID},
		{hKeyCurrentUser, `Software\Microsoft\EdgeUpdate\Clients\` + webView2RuntimeCLSID},
	} {
		if regPvPresent(k.root, k.path) {
			return true
		}
	}
	return false
}

func regPvPresent(root uintptr, path string) bool {
	name, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return false
	}
	var h uintptr
	if ret, _, _ := procRegOpenKeyExW.Call(root, uintptr(unsafe.Pointer(name)), 0, keyRead, uintptr(unsafe.Pointer(&h))); ret != 0 {
		return false
	}
	defer procRegCloseKey.Call(h)
	val, _ := syscall.UTF16PtrFromString("pv")
	var typ, n uint32
	if ret, _, _ := procRegQueryValueExW.Call(h, uintptr(unsafe.Pointer(val)), 0,
		uintptr(unsafe.Pointer(&typ)), 0, uintptr(unsafe.Pointer(&n))); ret != 0 || n == 0 {
		return false
	}
	return typ == rrtRegSz
}

// promptWebView2Download shows the native "runtime missing" dialog. The OK
// button (labelled 确定 in the message: 点击下载) opens Microsoft's official
// Evergreen WebView2 download link in the default browser; Cancel just closes
// the dialog. Returns true when the download page was opened.
func promptWebView2Download() bool {
	const (
		mbOKCANCEL = 0x1
		mbIconWarn = 0x30
		idOK       = 1
		swShownorm = 1
	)
	text, _ := syscall.UTF16PtrFromString(
		"未检测到 Microsoft WebView2 运行时,无法显示界面。\n\n" +
			"点击「确定(下载)」在浏览器中打开微软官方 WebView2 下载地址,\n" +
			"安装完成后重新运行本程序;点击「取消」关闭此弹窗。")
	caption, _ := syscall.UTF16PtrFromString("EasyEDA 查看器")
	ret, _, _ := procMessageBoxW.Call(0,
		uintptr(unsafe.Pointer(text)), uintptr(unsafe.Pointer(caption)), mbOKCANCEL|mbIconWarn)
	if int(ret) != idOK {
		return false // 取消 — close the dialog (the caller exits, webview cannot run)
	}
	// official Evergreen Bootstrapper fwlink from the WebView2 download page
	url, _ := syscall.UTF16PtrFromString("https://go.microsoft.com/fwlink/p/?LinkId=2124703")
	verb, _ := syscall.UTF16PtrFromString("open")
	procShellExecuteW.Call(0, uintptr(unsafe.Pointer(verb)),
		uintptr(unsafe.Pointer(url)), 0, 0, swShownorm)
	return true
}

// ---------- native dialogs ----------

type openFileName struct {
	lStructSize       uint32
	hwndOwner         uintptr
	hInstance         uintptr
	lpstrFilter       *uint16
	lpstrCustomFilter *uint16
	nMaxCustFilter    uint32
	nFilterIndex      uint32
	lpstrFile         *uint16
	nMaxFile          uint32
	lpstrFileTitle    *uint16
	nMaxFileTitle     uint32
	lpstrInitialDir   *uint16
	lpstrTitle        *uint16
	Flags             uint32
	nFileOffset       uint16
	nFileExtension    uint16
	lpstrDefExt       *uint16
	lCustData         uintptr
	lpfnHook          uintptr
	lpTemplateName    *uint16
	pvReserved        uintptr
	dwReserved        uint32
	FlagsEx           uint32
}

const (
	ofnFileMustExist = 0x00001000
	ofnPathMustExist = 0x00000800
	ofnHideReadOnly  = 0x00000004
)

func utf16z(s string) []uint16 {
	u, err := syscall.UTF16FromString(s)
	if err != nil {
		return nil
	}
	return u
}

func parseFilter(filter string) *uint16 {
	parts := strings.Split(filter, "|")
	var u16 []uint16
	for i := 0; i+1 < len(parts); i += 2 {
		u16 = append(u16, utf16z(parts[i])...)
		u16 = append(u16, utf16z(parts[i+1])...)
	}
	u16 = append(u16, 0)
	return &u16[0]
}

func openFileDialogWindows() (string, error) {
	const maxPath = 4096
	buf := make([]uint16, maxPath)
	title, _ := syscall.UTF16PtrFromString("打开 EasyEDA 工程文件")
	var ofn openFileName
	ofn.lStructSize = uint32(unsafe.Sizeof(ofn))
	ofn.hwndOwner = mainHwnd
	ofn.lpstrFilter = parseFilter(openFilter)
	ofn.nFilterIndex = 1
	ofn.lpstrFile = &buf[0]
	ofn.nMaxFile = maxPath
	ofn.lpstrTitle = title
	ofn.Flags = ofnFileMustExist | ofnPathMustExist | ofnHideReadOnly

	ret, _, _ := procGetOpenFileNameW.Call(uintptr(unsafe.Pointer(&ofn)))
	if ret == 0 {
		return "", nil // cancelled
	}
	return syscall.UTF16ToString(buf), nil
}

// ---------- modern folder picker (Vista+ Common Item Dialog) ----------

type guid struct {
	Data1 uint32
	Data2 uint16
	Data3 uint16
	Data4 [8]byte
}

var (
	clsidFileOpenDialog = guid{0xDC1C5A9C, 0xE88A, 0x4DDE, [8]byte{0xA5, 0xA1, 0x60, 0xF8, 0x2A, 0x20, 0xAE, 0xF7}}
	iidIFileDialog      = guid{0x42F85136, 0xDB7E, 0x439C, [8]byte{0x85, 0xF1, 0xE4, 0x07, 0x5D, 0x13, 0x5F, 0xC8}}
	iidIShellItem       = guid{0x43826D1E, 0xE718, 0x42EE, [8]byte{0xBC, 0x55, 0xA1, 0xE2, 0x61, 0xC3, 0x7B, 0xFE}}
)

type iFileDialog struct{ vtbl *iFileDialogVtbl }
type iFileDialogVtbl struct {
	queryInterface      uintptr
	addRef              uintptr
	release             uintptr
	show                uintptr
	setFileTypes        uintptr
	setFileTypeIndex    uintptr
	getFileTypeIndex    uintptr
	advise              uintptr
	unadvise            uintptr
	setOptions          uintptr
	getOptions          uintptr
	setDefaultFolder    uintptr
	setFileName         uintptr
	setTitle            uintptr
	setOkButtonLabel    uintptr
	setFileNameLabel    uintptr
	getResult           uintptr
	addPlace            uintptr
	setDefaultExtension uintptr
	close               uintptr
	setClientGuid       uintptr
	clearClientData     uintptr
	setFilter           uintptr
	getResults          uintptr
	getSelectedItems    uintptr
}

func (d *iFileDialog) Show(hwnd uintptr) uintptr {
	ret, _, _ := syscall.SyscallN(d.vtbl.show, uintptr(unsafe.Pointer(d)), hwnd)
	return ret
}
func (d *iFileDialog) SetTitle(title *uint16) uintptr {
	ret, _, _ := syscall.SyscallN(d.vtbl.setTitle, uintptr(unsafe.Pointer(d)), uintptr(unsafe.Pointer(title)))
	return ret
}
func (d *iFileDialog) SetOptions(opts uint32) uintptr {
	ret, _, _ := syscall.SyscallN(d.vtbl.setOptions, uintptr(unsafe.Pointer(d)), uintptr(opts))
	return ret
}
func (d *iFileDialog) GetResult(item **iShellItem) uintptr {
	ret, _, _ := syscall.SyscallN(d.vtbl.getResult, uintptr(unsafe.Pointer(d)), uintptr(unsafe.Pointer(item)))
	return ret
}
func (d *iFileDialog) Release() {
	if d != nil && d.vtbl != nil {
		syscall.SyscallN(d.vtbl.release, uintptr(unsafe.Pointer(d)))
	}
}

type iShellItem struct{ vtbl *iShellItemVtbl }
type iShellItemVtbl struct {
	queryInterface uintptr
	addRef         uintptr
	release        uintptr
	getDisplayName uintptr
	getAttributes  uintptr
	compare        uintptr
}

func (si *iShellItem) GetDisplayName(sigdn uint32, ppsz **uint16) uintptr {
	ret, _, _ := syscall.SyscallN(si.vtbl.getDisplayName, uintptr(unsafe.Pointer(si)), uintptr(sigdn), uintptr(unsafe.Pointer(ppsz)))
	return ret
}
func (si *iShellItem) Release() {
	if si != nil && si.vtbl != nil {
		syscall.SyscallN(si.vtbl.release, uintptr(unsafe.Pointer(si)))
	}
}

func openFolderDialogWindows() (string, error) {
	// COM must be initialized on this thread; ignore S_FALSE (already initialized).
	hr, _, _ := procCoInitializeEx.Call(0, uintptr(coInitApartmentThreaded))
	if int32(hr) < 0 {
		return "", fmt.Errorf("CoInitializeEx failed 0x%X", hr)
	}

	var dlg *iFileDialog
	hr, _, _ = procCoCreateInstance.Call(
		uintptr(unsafe.Pointer(&clsidFileOpenDialog)),
		0,
		uintptr(clsctxInprocServer),
		uintptr(unsafe.Pointer(&iidIFileDialog)),
		uintptr(unsafe.Pointer(&dlg)),
	)
	if int32(hr) < 0 || dlg == nil {
		return "", fmt.Errorf("CoCreateInstance IFileDialog failed 0x%X", hr)
	}
	defer dlg.Release()

	title, _ := syscall.UTF16PtrFromString("选择 EasyEDA 工程文件夹(.eprj3 目录)")
	dlg.SetTitle(title)
	dlg.SetOptions(fosPickFolders)

	hr = dlg.Show(mainHwnd)
	if hr == hresultErrorCancelled {
		return "", nil
	}
	if int32(hr) < 0 {
		return "", fmt.Errorf("IFileDialog.Show failed 0x%X", hr)
	}

	var item *iShellItem
	hr = dlg.GetResult(&item)
	if int32(hr) < 0 || item == nil {
		return "", fmt.Errorf("IFileDialog.GetResult failed 0x%X", hr)
	}
	defer item.Release()

	var path *uint16
	hr = item.GetDisplayName(sigdnFileSysPath, &path)
	if int32(hr) < 0 || path == nil {
		return "", fmt.Errorf("IShellItem.GetDisplayName failed 0x%X", hr)
	}
	defer procCoTaskMemFree.Call(uintptr(unsafe.Pointer(path)))

	return syscall.UTF16ToString((*[1 << 20]uint16)(unsafe.Pointer(path))[:]), nil
}
