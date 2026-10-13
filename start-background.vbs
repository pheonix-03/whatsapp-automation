Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
WshShell.CurrentDirectory = scriptDir

' Launch node server.js silently in the background (0 = hidden window)
WshShell.Run "node server.js", 0, False

' Wait 2.5 seconds for server to bind port, then open web browser
WScript.Sleep 2500
WshShell.Run "http://localhost:3000"
