#!/usr/bin/env node
/**
 * generate-icons.js
 * Generates simple PNG icons for StayActive Pro (OFF = gray, ON = blue).
 * Run once with: node generate-icons.js
 * Requires the `canvas` npm package (npm install canvas).
 *
 * After running, you'll find all PNGs in the icons/ directory.
 * To replace with custom artwork: just overwrite the PNGs.
 */

const { createCanvas } = require('canvas');
const fs   = require('fs');
const path = require('path');

const SIZES = [16, 32, 48, 128];
const OUT   = path.join(__dirname, 'icons');

if (!fs.existsSync(OUT)) fs.mkdirSync(OUT);

function drawIcon(size, color) {
  const canvas = createCanvas(size, size);
  const ctx    = canvas.getContext('2d');
  const pad    = Math.max(1, size * 0.08);
  const r      = (size - pad * 2) / 2;
  const cx     = size / 2;
  const cy     = size / 2;

  // Background circle
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = color === 'on' ? '#2563EB' : '#94A3B8';
  ctx.fill();

  // Inner highlight ring
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.72, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(255,255,255,0.28)';
  ctx.lineWidth   = Math.max(1, size * 0.06);
  ctx.stroke();

  // Lightning bolt / play symbol
  ctx.fillStyle = 'rgba(255,255,255,0.95)';
  const s = r * 0.55;

  if (size >= 32) {
    // Draw a stylised "eye" shape to represent "always visible"
    ctx.beginPath();
    // Outer ellipse (eye outline)
    ctx.ellipse(cx, cy, s, s * 0.6, 0, 0, Math.PI * 2);
    ctx.fill();

    // Inner pupil in the circle color
    ctx.beginPath();
    ctx.arc(cx, cy, s * 0.38, 0, Math.PI * 2);
    ctx.fillStyle = color === 'on' ? '#1d4ed8' : '#64748B';
    ctx.fill();

    // Pupil highlight
    ctx.beginPath();
    ctx.arc(cx - s * 0.1, cy - s * 0.1, s * 0.12, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.fill();
  } else {
    // At 16px just draw a solid white dot in the centre
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.45, 0, Math.PI * 2);
    ctx.fillStyle = 'white';
    ctx.fill();
  }

  return canvas.toBuffer('image/png');
}

for (const size of SIZES) {
  for (const state of ['off', 'on']) {
    const buf  = drawIcon(size, state);
    const file = path.join(OUT, `icon${size}_${state}.png`);
    fs.writeFileSync(file, buf);
    console.log('Created', file);
  }
}

console.log('\nDone!  Replace PNGs in icons/ with your own artwork at any time.');
