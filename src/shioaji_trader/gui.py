from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from PySide6.QtCore import QLockFile, QTimer, Qt
from PySide6.QtGui import QAction, QColor, QFont, QIcon, QPainter, QPixmap
from PySide6.QtWidgets import (
    QApplication, QDialog, QDialogButtonBox, QLineEdit, QMainWindow, QMenu,
    QMessageBox, QPlainTextEdit, QSystemTrayIcon, QVBoxLayout, QWidget,
)

from .models import Settings
from .service import Service
from .storage import Store, data_directory

HELP = """文字指令：
decide             立即重新分析
pause              暫停新增買進，既有保護監控持續
resume             恢復新增買進
stop               停止全部新委託（現有掛單仍存在）
continue           解除停止全部委託
cancel             撤銷本程式已確認的未完成委託
auto on / auto off 啟用／停止自動執行計畫
settings           開啟文字設定
calendar           更新本年度官方行事曆
help               顯示指令
exit               結束程式（關閉視窗則縮到系統匣）
"""


def tray_icon():
    pixmap = QPixmap(64, 64)
    pixmap.fill(Qt.GlobalColor.transparent)
    painter = QPainter(pixmap)
    painter.setRenderHint(QPainter.RenderHint.Antialiasing)
    painter.setBrush(QColor("#174c3c"))
    painter.setPen(Qt.PenStyle.NoPen)
    painter.drawRoundedRect(4, 4, 56, 56, 12, 12)
    painter.setPen(QColor("#ffffff"))
    painter.setFont(QFont("Consolas", 32, QFont.Weight.Bold))
    painter.drawText(pixmap.rect(), Qt.AlignmentFlag.AlignCenter, "T")
    painter.end()
    return QIcon(pixmap)


class SettingsDialog(QDialog):
    def __init__(self, settings, parent=None):
        super().__init__(parent)
        self.setWindowTitle("文字設定（沒有金鑰）")
        self.resize(660, 600)
        layout = QVBoxLayout(self)
        self.editor = QPlainTextEdit()
        self.editor.setPlainText(json.dumps(settings.model_dump(mode="json"), ensure_ascii=False, indent=2))
        layout.addWidget(self.editor)
        buttons = QDialogButtonBox(QDialogButtonBox.StandardButton.Save | QDialogButtonBox.StandardButton.Cancel)
        buttons.accepted.connect(self.save)
        buttons.rejected.connect(self.reject)
        layout.addWidget(buttons)
        self.value = None

    def save(self):
        try:
            self.value = Settings.model_validate_json(self.editor.toPlainText())
        except Exception:
            QMessageBox.warning(self, "設定格式", "設定不符合格式或風控範圍，請檢查數字、時間與欄位。")
            return
        self.accept()


class Window(QMainWindow):
    def __init__(self, service: Service, store: Store):
        super().__init__()
        self.service, self.store = service, store
        self.quitting = False
        self.setWindowTitle("Shioaji Codex Trader")
        self.resize(920, 680)
        self.setWindowIcon(tray_icon())
        body = QWidget()
        layout = QVBoxLayout(body)
        self.output = QPlainTextEdit()
        self.output.setReadOnly(True)
        self.output.setMaximumBlockCount(2500)
        self.output.setFont(QFont("Consolas", 11))
        self.command = QLineEdit()
        self.command.setPlaceholderText("輸入 help 查看指令；decide 立即分析；settings 修改設定")
        self.command.returnPressed.connect(self.handle_command)
        layout.addWidget(self.output)
        layout.addWidget(self.command)
        self.setCentralWidget(body)
        self.help_visible = False
        self.tray = QSystemTrayIcon(self.windowIcon(), self)
        self.tray.setToolTip("Shioaji Codex Trader")
        menu = QMenu(self)
        for label, command in [("開啟文字視窗", "show"), ("立即分析", "decide"),
                               ("暫停新增買進", "pause"), ("恢復新增買進", "resume"),
                               ("停止全部新委託", "stop"), ("撤銷本程式掛單", "cancel"),
                               ("設定", "settings"), ("結束程式", "exit")]:
            action = QAction(label, self)
            action.triggered.connect(lambda checked=False, cmd=command: self.dispatch(cmd))
            menu.addAction(action)
        self.tray.setContextMenu(menu)
        self.tray.activated.connect(self.activated)
        self.tray.show()
        self.timer = QTimer(self)
        self.timer.timeout.connect(self.refresh)
        self.timer.start(1000)
        self.refresh()

    def activated(self, reason):
        if reason in {QSystemTrayIcon.ActivationReason.Trigger, QSystemTrayIcon.ActivationReason.DoubleClick}:
            self.dispatch("show")

    def refresh(self):
        text = self.service.status()
        if self.help_visible:
            text += "\n\n"+HELP
        if text != self.output.toPlainText():
            bar = self.output.verticalScrollBar()
            position = bar.value()
            self.output.setPlainText(text)
            bar.setValue(position)

    def handle_command(self):
        command = self.command.text().strip().lower()
        self.command.clear()
        self.dispatch(command)

    def dispatch(self, command):
        if command == "show":
            self.showNormal()
            self.raise_()
            self.activateWindow()
        elif command == "decide":
            self.service.post("decision", False)
        elif command in {"pause", "resume"}:
            self.service.post("pause", command == "pause")
        elif command in {"stop", "continue"}:
            self.service.post("kill", command == "stop")
        elif command == "cancel":
            self.service.post("cancel_owned")
        elif command == "calendar":
            self.service.post("calendar")
        elif command in {"auto on", "auto off"}:
            updated = self.store.settings()
            updated.auto_execute = command == "auto on"
            self.service.post("settings", updated)
        elif command == "settings":
            dialog = SettingsDialog(self.store.settings(), self)
            if dialog.exec() == QDialog.DialogCode.Accepted:
                current = self.store.settings()
                updated = dialog.value
                if updated.mode != current.mode or updated.whole_lots != current.whole_lots:
                    QMessageBox.information(self, "交易模式", "模式與整股開關請使用本機 CLI 修改後重新啟動；實盤使用 enable-live。")
                    return
                self.service.post("settings", updated)
        elif command == "help":
            self.help_visible = not self.help_visible
            self.refresh()
        elif command == "exit":
            self.quit_app()
        elif command:
            self.help_visible = True
            self.refresh()

    def changeEvent(self, event):
        super().changeEvent(event)
        if self.isMinimized() and QSystemTrayIcon.isSystemTrayAvailable():
            QTimer.singleShot(0, self.hide)

    def closeEvent(self, event):
        if self.quitting:
            event.accept()
        elif QSystemTrayIcon.isSystemTrayAvailable():
            self.hide()
            event.ignore()
        else:
            self.quit_app()
            event.accept()

    def quit_app(self):
        self.quitting = True
        self.timer.stop()
        self.service.stop()
        self.tray.hide()
        QApplication.instance().quit()


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", type=Path, default=data_directory()/"state.db")
    parser.add_argument("--minimized", action="store_true")
    args = parser.parse_args(argv)
    app = QApplication.instance() or QApplication(sys.argv[:1])
    app.setApplicationName("ShioajiCodexTrader")
    app.setQuitOnLastWindowClosed(False)
    args.db.parent.mkdir(parents=True, exist_ok=True)
    lock = QLockFile(str(args.db)+".lock")
    if not lock.tryLock(0):
        QMessageBox.information(None, "程式已執行", "同一份帳戶狀態已由另一個程式使用。")
        return 1
    store = Store(args.db)
    try:
        service = Service(store)
        window = Window(service, store)
        service.start()
        if not ((args.minimized or store.settings().start_minimized) and QSystemTrayIcon.isSystemTrayAvailable()):
            window.show()
        result = app.exec()
        service.stop()
        return result
    finally:
        store.close()
        lock.unlock()
