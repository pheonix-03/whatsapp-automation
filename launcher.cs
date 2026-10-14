using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Threading;
using System.Windows.Forms;

namespace LeadSquaredCRM
{
    static class Program
    {
        private static NotifyIcon trayIcon;
        private static ContextMenu trayMenu;
        private static Process serverProcess;
        private static Process openwaProcess;
        private static Process electronProcess;
        private static string appDir;

        [STAThread]
        static void Main()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            appDir = AppDomain.CurrentDomain.BaseDirectory;
            Directory.SetCurrentDirectory(appDir);

            // Setup System Tray Menu
            trayMenu = new ContextMenu();
            trayMenu.MenuItems.Add(new MenuItem("🖥️ Open Desktop Window", (s, e) => OpenAppWindow()));
            trayMenu.MenuItems.Add(new MenuItem("🌐 Open in Web Browser", (s, e) => OpenBrowser("http://localhost:3000")));
            trayMenu.MenuItems.Add(new MenuItem("📱 Scan WhatsApp QR Code", (s, e) => OpenAppOrBrowser("http://localhost:3000#whatsapp")));
            trayMenu.MenuItems.Add(new MenuItem("-"));
            trayMenu.MenuItems.Add(new MenuItem("🔄 Restart CRM Services", (s, e) => RestartServices()));
            trayMenu.MenuItems.Add(new MenuItem("🛑 Exit / Stop Server", (s, e) => ShutdownAndExit()));

            trayIcon = new NotifyIcon();
            trayIcon.Text = "LeadSquared CRM + WhatsApp Automation";
            trayIcon.Icon = SystemIcons.Application;
            trayIcon.ContextMenu = trayMenu;
            trayIcon.Visible = true;
            trayIcon.DoubleClick += (s, e) => OpenAppWindow();

            // Start backend services in background thread
            Thread starterThread = new Thread(StartServicesAndOpenApp);
            starterThread.IsBackground = true;
            starterThread.Start();

            Application.Run();
        }

        private static void StartServicesAndOpenApp()
        {
            try
            {
                // 1. Check if server is already running on port 3000
                if (!IsServerRunning("http://127.0.0.1:3000/api/health"))
                {
                    // Clean orphaned Chrome/Puppeteer processes first
                    RunCleanPuppeteer();

                    // Start CRM Server silently
                    ProcessStartInfo psi = new ProcessStartInfo();
                    psi.FileName = "node";
                    psi.Arguments = "server.js";
                    psi.WorkingDirectory = appDir;
                    psi.CreateNoWindow = true;
                    psi.UseShellExecute = false;
                    psi.WindowStyle = ProcessWindowStyle.Hidden;

                    serverProcess = Process.Start(psi);

                    // Start OpenWA if directory exists
                    string openwaDir = Path.Combine(appDir, "OpenWA");
                    string openwaMain = Path.Combine(openwaDir, "dist", "main.js");
                    if (Directory.Exists(openwaDir) && File.Exists(openwaMain))
                    {
                        ProcessStartInfo owaPsi = new ProcessStartInfo();
                        owaPsi.FileName = "node";
                        owaPsi.Arguments = "dist/main.js";
                        owaPsi.WorkingDirectory = openwaDir;
                        owaPsi.CreateNoWindow = true;
                        owaPsi.UseShellExecute = false;
                        owaPsi.WindowStyle = ProcessWindowStyle.Hidden;
                        try { openwaProcess = Process.Start(owaPsi); } catch { }
                    }

                    // Wait up to 12 seconds for server to be ready
                    int waited = 0;
                    while (waited < 12 && !IsServerRunning("http://127.0.0.1:3000/api/health"))
                    {
                        Thread.Sleep(1000);
                        waited++;
                    }
                }

                // Show notification and launch window
                trayIcon.ShowBalloonTip(3000, "LeadSquared CRM Started", "CRM is ready. Double-click tray icon anytime to open.", ToolTipIcon.Info);
                OpenAppWindow();
            }
            catch (Exception ex)
            {
                MessageBox.Show("Failed to start CRM: " + ex.Message, "LeadSquared CRM Error", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private static void OpenAppWindow()
        {
            string electronExe = Path.Combine(appDir, "node_modules", "electron", "dist", "electron.exe");
            string electronScript = Path.Combine(appDir, "electron-main.js");

            if (File.Exists(electronExe) && File.Exists(electronScript))
            {
                try
                {
                    if (electronProcess == null || electronProcess.HasExited)
                    {
                        ProcessStartInfo psi = new ProcessStartInfo();
                        psi.FileName = electronExe;
                        psi.Arguments = "\"" + electronScript + "\"";
                        psi.WorkingDirectory = appDir;
                        psi.UseShellExecute = false;
                        electronProcess = Process.Start(psi);
                    }
                    return;
                }
                catch { }
            }

            // Fallback to browser if Electron not available
            OpenBrowser("http://localhost:3000");
        }

        private static void OpenAppOrBrowser(string url)
        {
            OpenBrowser(url);
        }

        private static bool IsServerRunning(string url)
        {
            try
            {
                HttpWebRequest req = (HttpWebRequest)WebRequest.Create(url);
                req.Timeout = 1500;
                req.Method = "GET";
                using (HttpWebResponse res = (HttpWebResponse)req.GetResponse())
                {
                    return res.StatusCode == HttpStatusCode.OK;
                }
            }
            catch
            {
                return false;
            }
        }

        private static void RunCleanPuppeteer()
        {
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo();
                psi.FileName = "node";
                psi.Arguments = "-e \"try { require('./clean_puppeteer')(); } catch(e){}\"";
                psi.WorkingDirectory = appDir;
                psi.CreateNoWindow = true;
                psi.UseShellExecute = false;
                Process p = Process.Start(psi);
                p.WaitForExit(3000);
            }
            catch { }
        }

        private static void OpenBrowser(string url)
        {
            try
            {
                Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
            }
            catch
            {
                Process.Start("cmd.exe", "/c start " + url);
            }
        }

        private static void RestartServices()
        {
            KillExistingNodeServers();
            trayIcon.ShowBalloonTip(2000, "Restarting...", "Restarting LeadSquared CRM backend services...", ToolTipIcon.Info);
            Thread t = new Thread(StartServicesAndOpenApp);
            t.IsBackground = true;
            t.Start();
        }

        private static void KillExistingNodeServers()
        {
            try
            {
                if (electronProcess != null && !electronProcess.HasExited)
                {
                    electronProcess.Kill();
                }
            }
            catch { }

            try
            {
                if (serverProcess != null && !serverProcess.HasExited)
                {
                    serverProcess.Kill();
                }
            }
            catch { }

            try
            {
                if (openwaProcess != null && !openwaProcess.HasExited)
                {
                    openwaProcess.Kill();
                }
            }
            catch { }
        }

        private static void ShutdownAndExit()
        {
            KillExistingNodeServers();
            trayIcon.Visible = false;
            trayIcon.Dispose();
            Application.Exit();
            Environment.Exit(0);
        }
    }
}
