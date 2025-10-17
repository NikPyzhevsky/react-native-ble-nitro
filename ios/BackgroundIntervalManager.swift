//
//  BackgroundIntervalManager.swift
//  Pods
//
//  Created by Mikita on 10/17/25.
//

import UIKit

final class BackgroundIntervalManager {
  typealias Tick = () -> Void

  private var timer: DispatchSourceTimer?
  private let timerQueue = DispatchQueue(label: "bg.interval.manager.timer")
  private var bgTask: UIBackgroundTaskIdentifier = .invalid
  private var onTick: Tick?
  private var interval: TimeInterval = 1.0
  private var running = false

  deinit { stop() }

  func start(interval: Double, tick: @escaping Tick) {
    // Можно вызывать с любого потока — сами уйдём на main где нужно
    self.interval = max(0.1, interval)
    self.onTick = tick

    // наблюдатели и background task — ТОЛЬКО на main
    runOnMain {
      guard !self.running else { return }
      self.running = true

      NotificationCenter.default.addObserver(
        self,
        selector: #selector(self.didEnterBG),
        name: UIApplication.didEnterBackgroundNotification,
        object: nil
      )
      NotificationCenter.default.addObserver(
        self,
        selector: #selector(self.willEnterFG),
        name: UIApplication.willEnterForegroundNotification,
        object: nil
      )

      // если уже в фоне — возьмём квоту
      if UIApplication.shared.applicationState != .active {
        self.beginBGTask_onMain()
      }

      // таймер можно на фоне — он лишь вызывает tick
      let t = DispatchSource.makeTimerSource(queue: self.timerQueue)
      t.schedule(deadline: .now() + self.interval,
                 repeating: self.interval,
                 leeway: .nanoseconds(0))
      t.setEventHandler { [weak self] in
        guard let self = self else { return }
        // вызывать пользовательский колбек на main (RN любит main)
        runOnMain { self.onTick?() }
      }
      t.resume()
      self.timer = t
    }
  }

  func stop() {
    // можно с любого потока
    timer?.cancel()
    timer = nil

    runOnMain {
      if self.running {
        NotificationCenter.default.removeObserver(self)
      }
      self.endBGTask_onMain()
      self.running = false
      self.onTick = nil
    }
  }

  @objc private func didEnterBG() {
    beginBGTask_onMain()
  }

  @objc private func willEnterFG() {
    endBGTask_onMain()
  }

  // MARK: - Main-only helpers

  private func beginBGTask_onMain() {
    assert(Thread.isMainThread)
    guard bgTask == .invalid else { return }
    bgTask = UIApplication.shared.beginBackgroundTask(withName: "interval.manager") { [weak self] in
      // система отобрала фон — просто завершим бэкграунд-таск
      self?.endBGTask_onMain()
    }
  }

  private func endBGTask_onMain() {
    assert(Thread.isMainThread)
    guard bgTask != .invalid else { return }
    UIApplication.shared.endBackgroundTask(bgTask)
    bgTask = .invalid
  }
}

// Утилита: безопасно выполнить на main
@inline(__always)
private func runOnMain(_ block: @escaping () -> Void) {
  if Thread.isMainThread { block() } else { DispatchQueue.main.async { block() } }
}
