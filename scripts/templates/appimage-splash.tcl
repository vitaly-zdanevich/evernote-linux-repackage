#!/usr/bin/env wish

if {[llength $argv] < 1} {
    exit 0
}

set logo_path [lindex $argv 0]
set width 430
set height 280
set phase 0

wm withdraw .
toplevel .splash
wm overrideredirect .splash 1
catch {wm attributes .splash -topmost 1}
wm title .splash "Evernote"

set screen_width [winfo screenwidth .]
set screen_height [winfo screenheight .]
set x [expr {int(($screen_width - $width) / 2)}]
set y [expr {int(($screen_height - $height) / 2)}]
wm geometry .splash ${width}x${height}+${x}+${y}
.splash configure -background "#000000"

image create photo evernote_logo -file $logo_path
label .splash.logo \
    -image evernote_logo \
    -background "#000000" \
    -borderwidth 0 \
    -highlightthickness 0

canvas .splash.scan \
    -width 150 \
    -height 4 \
    -background "#000000" \
    -borderwidth 0 \
    -highlightthickness 0

pack .splash.logo -side top -pady {56 28}
pack .splash.scan -side top

proc animate_splash {} {
    global phase

    set width 150
    set wave [expr {abs(($phase % 60) - 30)}]
    set line_width [expr {70 + int($wave * 1.8)}]
    set x0 [expr {int(($width - $line_width) / 2)}]
    set x1 [expr {$x0 + $line_width}]

    .splash.scan delete all
    .splash.scan create line $x0 2 $x1 2 \
        -fill "#00A82D" \
        -width 4 \
        -capstyle round

    incr phase
    after 32 animate_splash
}

animate_splash
after 15000 exit
