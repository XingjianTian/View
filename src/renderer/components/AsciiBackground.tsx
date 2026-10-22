import { useEffect, useRef } from 'react';
import { isPerformanceProtected, motionEnabled, setPerformanceProtected, useSystemReducedMotion, visibleElapsedDelta } from '../motion.js';
import { ASCII_TOUCH_STATIC_FRAME_MS, drawAsciiTouchFrame, loadTintedAsciiTouchImages, type TouchImagePair } from '../ascii/touch.js';

type Props = {
  mode: 'dynamic' | 'static' | 'off';
  brightness: number;
  strength: number;
  reducedMotion: boolean;
  paused?: boolean;
  visible?: boolean;
  windowEpoch?: number;
};

type RenderQuality = {
  level: 0 | 1 | 2;
  slowWindows: number;
  targetInterval: number;
  nextSampleAt: number;
};

const DPR_LIMIT = 1.5;
const DRAW_BUDGET_MS = 8;
const SAMPLE_WINDOW = 60;
const TARGET_FRAME_INTERVAL = 1000 / 60;
const DEGRADED_FRAME_INTERVAL = 1000 / 30;

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function percentile(values: readonly number[], fraction: number) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))] ?? 0;
}

export function AsciiBackground({ mode, brightness, strength, reducedMotion, paused = false, visible = true, windowEpoch }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const systemReducedMotion = useSystemReducedMotion();
  const visibleElapsedRef = useRef(mode === 'static' || reducedMotion ? ASCII_TOUCH_STATIC_FRAME_MS : 0);
  const diagnosticsRef = useRef({
    draws: 0,
    lastFpsAt: 0,
    windowDraws: 0,
    samples: [] as number[],
    recentDraws: [] as number[],
    frameIntervals: [] as number[],
    lastCompletedAt: 0,
    lastDrawDuration: 0,
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext('2d');
    if (!context) return;
    const diagnostics = diagnosticsRef.current;
    diagnostics.windowDraws = 0;
    diagnostics.lastFpsAt = 0;
    diagnostics.lastCompletedAt = 0;
    diagnostics.samples.length = 0;
    diagnostics.recentDraws.length = 0;
    diagnostics.frameIntervals.length = 0;
    diagnostics.lastDrawDuration = 0;
    canvas.dataset.motionFps = '0';
    canvas.dataset.motionDrawP95Ms = '';
    canvas.dataset.motionFrameP95Ms = '';
    let disposed = false;
    let hidden = document.hidden || !visible;
    let viewportWidth = window.innerWidth;
    let viewportHeight = window.innerHeight;
    let pixelRatio = Math.min(window.devicePixelRatio || 1, DPR_LIMIT);
    let images: TouchImagePair | null = null;
    const quality: RenderQuality = { level: 0, slowWindows: 0, targetInterval: TARGET_FRAME_INTERVAL, nextSampleAt: 0 };
    let animationFrame: number | undefined;
    let resizeTimer: number | undefined;
    let rafClock: number | undefined;
    let frameDebt = 0;
    let lastDiagnosticsAt = 0;
    let lastTick = performance.now();
    let warmupFrames = 3;
    const intensity = clamp(.44 + (brightness / 100) * (.30 + (strength / 100) * .26), .24, 1);

    const canAnimate = () => !disposed && !hidden && !paused && motionEnabled(mode, reducedMotion, systemReducedMotion, isPerformanceProtected());

    const cancelFrame = () => {
      if (animationFrame !== undefined) {
        window.cancelAnimationFrame(animationFrame);
        animationFrame = undefined;
      }
      rafClock = undefined;
      frameDebt = 0;
    };

    const resetCanvas = () => {
      pixelRatio = Math.min(window.devicePixelRatio || 1, quality.level === 0 ? DPR_LIMIT : 1);
      canvas.width = Math.floor(viewportWidth * pixelRatio);
      canvas.height = Math.floor(viewportHeight * pixelRatio);
      canvas.style.width = viewportWidth + 'px';
      canvas.style.height = viewportHeight + 'px';
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    };

    const setDiagnostics = (status: string, now: number) => {
      const current = diagnosticsRef.current;
      if (!current.lastFpsAt) current.lastFpsAt = now;
      const fpsElapsed = now - current.lastFpsAt;
      const fpsWindowReady = fpsElapsed >= 1_000;
      const reportsFps = status === 'dynamic' || status === 'degraded-quality' || status === 'degraded-30';
      if (!reportsFps) canvas.dataset.motionFps = '0';
      if (!fpsWindowReady && status === canvas.dataset.motionState && now - lastDiagnosticsAt < 1_000) return;
      lastDiagnosticsAt = now;
      canvas.dataset.motionState = status;
      canvas.dataset.motionEpoch = String(windowEpoch ?? '');
      canvas.dataset.motionMode = mode;
      canvas.dataset.motionVisible = String(!hidden && visible);
      canvas.dataset.motionPaused = String(paused);
      canvas.dataset.motionQuality = quality.level === 0 ? 'full' : quality.level === 1 ? 'reduced-density' : '30fps';
      canvas.dataset.motionTargetFps = mode === 'dynamic' && !reducedMotion && !systemReducedMotion && !paused && !isPerformanceProtected()
        ? String(Math.round(1000 / quality.targetInterval))
        : '0';
      canvas.dataset.motionDraws = String(current.draws);
      canvas.dataset.motionDrawP95Ms = current.recentDraws.length ? percentile(current.recentDraws, .95).toFixed(2) : '';
      canvas.dataset.motionFrameP95Ms = current.frameIntervals.length ? percentile(current.frameIntervals, .95).toFixed(2) : '';
      canvas.dataset.motionLastDrawMs = current.lastDrawDuration ? current.lastDrawDuration.toFixed(2) : '';
      if (fpsWindowReady) {
        canvas.dataset.motionFps = reportsFps ? (current.windowDraws * 1_000 / fpsElapsed).toFixed(1) : '0';
        current.lastFpsAt = now;
        current.windowDraws = 0;
      }
      if (status === 'hidden') canvas.dataset.motionReason = '原生窗口不可见';
      else if (status === 'off') canvas.dataset.motionReason = '背景已关闭';
      else if (status === 'paused') canvas.dataset.motionReason = '用户已暂停背景';
      else if (status === 'static') canvas.dataset.motionReason = '静态模式';
      else if (status === 'static-protected') canvas.dataset.motionReason = '绘制持续超预算，已静态保护';
      else if (!canvas.dataset.motionReason || canvas.dataset.motionReason === '用户已暂停背景' || canvas.dataset.motionReason === '原生窗口不可见') canvas.dataset.motionReason = '运行中';
    };

    const updatePerformance = (drawDuration: number, now: number) => {
      const current = diagnosticsRef.current;
      current.draws += 1;
      current.windowDraws += 1;
      current.lastDrawDuration = drawDuration;
      current.recentDraws.push(drawDuration);
      if (current.recentDraws.length > SAMPLE_WINDOW * 2) current.recentDraws.shift();
      if (current.lastCompletedAt > 0) {
        current.frameIntervals.push(Math.max(0, now - current.lastCompletedAt));
        if (current.frameIntervals.length > SAMPLE_WINDOW * 2) current.frameIntervals.shift();
      }
      current.lastCompletedAt = now;
      current.samples.push(drawDuration);
      const status = mode === 'dynamic'
        ? paused ? 'paused' : isPerformanceProtected() ? 'static-protected' : quality.level === 0 ? 'dynamic' : quality.level === 1 ? 'degraded-quality' : 'degraded-30'
        : mode === 'off' ? 'off' : paused ? 'paused' : 'static';
      setDiagnostics(status, now);
      if (mode !== 'dynamic' || reducedMotion || systemReducedMotion || paused || isPerformanceProtected()) return;
      if (warmupFrames > 0) {
        warmupFrames -= 1;
        return;
      }
      if (current.samples.length < SAMPLE_WINDOW || now < quality.nextSampleAt) return;
      quality.nextSampleAt = now + 250;
      const p95 = percentile(current.samples, .95);
      current.samples.length = 0;
      if (p95 <= DRAW_BUDGET_MS) {
        quality.slowWindows = 0;
        return;
      }
      quality.slowWindows += 1;
      if (quality.slowWindows < 2) return;
      quality.slowWindows = 0;
      if (quality.level === 0) {
        quality.level = 1;
        resetCanvas();
        canvas.dataset.motionReason = '绘制耗时超预算，已降低字符密度';
      } else if (quality.level === 1) {
        quality.level = 2;
        quality.targetInterval = DEGRADED_FRAME_INTERVAL;
        canvas.dataset.motionReason = '绘制耗时持续超预算，已降至30帧';
      } else {
        setPerformanceProtected(true);
        canvas.dataset.motionState = 'static-protected';
        cancelFrame();
      }
    };

    const draw = (advanceTime: boolean) => {
      const started = performance.now();
      const now = performance.now();
      if (advanceTime && canAnimate()) visibleElapsedRef.current += visibleElapsedDelta(now - lastTick);
      lastTick = now;
      if (mode === 'off' || hidden || !visible) {
        context.clearRect(0, 0, viewportWidth, viewportHeight);
        setDiagnostics(mode === 'off' ? 'off' : 'hidden', now);
        return;
      }
      if (!images) {
        setDiagnostics(mode === 'dynamic' ? 'dynamic' : 'static', now);
        return;
      }
      drawAsciiTouchFrame(context, viewportWidth, viewportHeight, visibleElapsedRef.current, images, {
        intensity,
        qualityLevel: quality.level,
        staticFrame: mode === 'static' || reducedMotion || systemReducedMotion,
      });
      updatePerformance(performance.now() - started, performance.now());
    };

    const schedule = () => {
      if (!canAnimate() || animationFrame !== undefined) return;
      animationFrame = window.requestAnimationFrame((rafNow) => {
        animationFrame = undefined;
        if (rafClock === undefined) rafClock = rafNow;
        frameDebt += clamp(rafNow - rafClock, 0, 1_000);
        rafClock = rafNow;
        if (frameDebt >= quality.targetInterval) {
          frameDebt %= quality.targetInterval;
          draw(true);
        }
        schedule();
      });
    };

    const resizeNow = () => {
      viewportWidth = window.innerWidth;
      viewportHeight = window.innerHeight;
      resetCanvas();
      lastTick = performance.now();
      draw(false);
    };

    const scheduleResize = () => {
      if (resizeTimer !== undefined) window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        resizeTimer = undefined;
        if (!disposed) resizeNow();
      }, 80);
    };

    const handleVisibility = () => {
      hidden = document.hidden || !visible;
      if (hidden) {
        cancelFrame();
        context.clearRect(0, 0, viewportWidth, viewportHeight);
        setDiagnostics('hidden', performance.now());
        return;
      }
      lastTick = performance.now();
      draw(false);
      schedule();
    };

    window.addEventListener('resize', scheduleResize);
    document.addEventListener('visibilitychange', handleVisibility);
    resizeNow();
    schedule();
    void loadTintedAsciiTouchImages().then((loaded) => {
      if (disposed) return;
      images = loaded;
      resizeNow();
      schedule();
    }).catch(() => {
      if (!disposed) canvas.dataset.motionReason = 'ASCII背景图层加载失败';
    });

    return () => {
      disposed = true;
      cancelFrame();
      if (resizeTimer !== undefined) window.clearTimeout(resizeTimer);
      window.removeEventListener('resize', scheduleResize);
      document.removeEventListener('visibilitychange', handleVisibility);
      context.globalAlpha = 1;
      context.globalCompositeOperation = 'source-over';
      context.clearRect(0, 0, viewportWidth, viewportHeight);
    };
  }, [mode, brightness, strength, reducedMotion, systemReducedMotion, paused, visible, windowEpoch]);

  return <canvas ref={canvasRef} className="ascii-background" aria-hidden="true" />;
}
