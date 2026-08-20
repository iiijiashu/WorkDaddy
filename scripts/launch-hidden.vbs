Option Explicit

If WScript.Arguments.Named.Exists("check") Then WScript.Quit 0

Dim shell, fso, scriptDir, launcher, command
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
launcher = fso.BuildPath(scriptDir, "launcher.cmd")
command = "%ComSpec% /d /c call """ & launcher & """"

' 0 = hidden window, False = do not block Explorer / login startup.
shell.Run command, 0, False
