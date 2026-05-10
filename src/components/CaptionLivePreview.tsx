import { useLayoutEffect, useRef, useState } from 'react';
import { cssHex, normalizeCaptionHex } from '../captionColor';
import { formatPreviewSubtitleText, type PreviewCaptionMode } from '../captionLayoutShared';

type CaptionSettings = {
  fontSize: number;
  marginV: number;
  marginLR: number;
  outline: number;
  primaryColor: string;
  outlineColor: string;
  shadow: number;
  maxWordsPerLine: number;
  maxWordsPerCue: number;
};

type Props = {
  captions: CaptionSettings;
  /** Live draft: script or caption wording — updates as you type */
  previewText: string;
  /** singleBeat matches one moment in the exported video; fullScript stacks all cues (differs from playback) */
  mode?: PreviewCaptionMode;
  className?: string;
};

export function CaptionLivePreview({ captions, previewText, mode = 'singleBeat', className }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [dims, setDims] = useState({ w: 315, h: 560 });

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) setDims({ w: r.width, h: r.height });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /** Match PlayRes 1080×1920 scaling (same as libass vs frame). */
  const scale = Math.min(dims.w / 1080, dims.h / 1920);
  const fontPx = Math.max(8, captions.fontSize * scale);
  const sidePad = captions.marginLR * scale;
  const nudgeY = -captions.marginV * scale;
  /** ASS Outline is roughly this many pixels at PlayRes; thin stroke in browser */
  const strokePx = Math.max(0, captions.outline * scale);
  const fill = cssHex(normalizeCaptionHex(captions.primaryColor, 'ffffff'));
  const strokeColor = cssHex(normalizeCaptionHex(captions.outlineColor, '000000'));
  const shadowDepth = Math.max(0, captions.shadow);
  /** Approximate ASS shadow: stepped offset behind the glyph */
  const dropShadowCss = (() => {
    if (shadowDepth <= 0) return 'none';
    const layers: string[] = [];
    const maxLayers = Math.min(8, shadowDepth);
    for (let i = 1; i <= maxLayers; i += 1) {
      const t = i / maxLayers;
      const ox = Math.max(0.5, t * shadowDepth * scale * 1.6);
      const blur = Math.max(0.25, t * shadowDepth * scale * 0.35);
      layers.push(`${ox}px ${ox}px ${blur}px rgba(0,0,0,${0.28 + t * 0.25})`);
    }
    return layers.join(', ');
  })();

  const display = previewText.trim() || 'Caption preview';
  const wrapped = formatPreviewSubtitleText(display, captions, mode);

  return (
    <div ref={wrapRef} className={`caption-live-preview ${className ?? ''}`}>
      <div className="caption-live-preview-inner">
        <div
          className="caption-live-preview-block"
          style={{
            paddingLeft: sidePad,
            paddingRight: sidePad,
            transform: `translateY(${nudgeY}px)`,
            maxWidth: '100%',
            boxSizing: 'border-box',
          }}
        >
          <p
            className="caption-live-preview-text"
            style={{
              margin: 0,
              textAlign: 'center',
              fontFamily: '"Arial Black", "Helvetica Neue", Arial, sans-serif',
              fontWeight: 900,
              fontSize: `${fontPx}px`,
              lineHeight: 1.08,
              letterSpacing: '0.01em',
              color: fill,
              WebkitTextStroke: strokePx > 0.15 ? `${strokePx}px ${strokeColor}` : undefined,
              paintOrder: strokePx > 0.15 ? 'stroke fill' : undefined,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              overflowWrap: 'break-word',
              textShadow: dropShadowCss,
              WebkitFontSmoothing: 'antialiased',
            }}
          >
            {wrapped}
          </p>
        </div>
      </div>
    </div>
  );
}
