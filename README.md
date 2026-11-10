# YAESU-REMOTE

Small Wi-Fi box (Raspberry Pi Zero 2 W) for remote control of Yaesu FTX-1, FTDX10 and FT-710 in the browser.

Spin-off of [SHACK-SERVER](https://github.com/cgraf63/SHACK-SERVER). This initial commit imports the source files from SHACK-SERVER `main` @ d8ba4c8 unchanged (FTX-1/FTDX10 drivers, serial base, `/api/ftx1` route, FTX-1 remote page, audio WebSocket). They do not build on their own yet: `radio-manager` and `settings.config` still have to be replaced by the slim server.
