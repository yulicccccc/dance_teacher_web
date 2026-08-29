property appName : "舞蹈老师"
property launcherPath : "/Users/claw/WorkBuddy/2026-07-24-22-13-28/start_local.sh"
property logPath : "/tmp/dance-teacher-launcher.log"

on run
	display notification "正在检查并启动本地完整版…" with title appName

	try
		do shell script "/bin/bash " & quoted form of launcherPath & " >" & quoted form of logPath & " 2>&1"
		display notification "已经打开，可以开始练习" with title appName
	on error errorText number errorNumber
		set diagnosticText to ""
		try
			set diagnosticText to do shell script "/usr/bin/tail -n 16 " & quoted form of logPath
		on error
			set diagnosticText to errorText
		end try

		display dialog "本地版没有成功启动。\n\n" & diagnosticText buttons {"知道了"} default button 1 with title appName with icon stop
	end try
end run
