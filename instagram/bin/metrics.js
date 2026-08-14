#!/usr/bin/env node
// Performance intake. Without this the "optimize for clicks and likes" instruction is a
// guess that never improves.
//
//   node instagram/bin/metrics.js --pending
//   node instagram/bin/metrics.js --post 2026-08-13-slug --likes 142 --views 5120 --saves 31
//   node instagram/bin/metrics.js --top
//
// Every number is optional. A prompt that demands nine figures every morning gets abandoned
// by week two, so partial rows are first class and missing fields stay null.
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { readPosts, readMetrics, appendMetric } from '../lib/history/store.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const STALE_DAYS = 5;

const { values } = parseArgs({
  options: {
    pending: { type: 'boolean', default: false },
    top: { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
    post: { type: 'string' },
    likes: { type: 'string' },
    views: { type: 'string' },
    saves: { type: 'string' },
    comments: { type: 'string' },
    shares: { type: 'string' },
    notes: { type: 'string' },
  },
});

const num = (v) => (v === undefined || v === '' ? null : Number(v));
const daysBetween = (a, b) => (new Date(a).getTime() - new Date(b).getTime()) / 86_400_000;

const posts = readPosts(REPO_ROOT);
const metrics = readMetrics(REPO_ROOT);
const now = new Date();

function newestMeasurement(postId) {
  return metrics
    .filter((m) => m.postId === postId)
    .sort((a, b) => new Date(b.measuredAt) - new Date(a.measuredAt))[0] ?? null;
}

if (values.pending) {
  const pending = posts
    .filter((p) => p.publishedAt)
    .slice(-10)
    .map((p) => ({ post: p, latest: newestMeasurement(p.id) }))
    .filter(({ latest }) => !latest || daysBetween(now, latest.measuredAt) > STALE_DAYS);

  if (values.json) {
    console.log(JSON.stringify(pending.map(({ post, latest }) => ({
      id: post.id, headline: post.copy?.headline ?? null,
      publishedAt: post.publishedAt, latest,
    })), null, 2));
  } else if (!pending.length) {
    console.log('Every recent post has a fresh measurement. Nothing to ask about.');
  } else {
    console.log(`${pending.length} post(s) need numbers:\n`);
    for (const { post, latest } of pending) {
      const seen = latest ? `last measured ${daysBetween(now, latest.measuredAt).toFixed(0)}d ago` : 'never measured';
      console.log(`  ${post.id}`);
      console.log(`    "${post.copy?.headline ?? '(no headline)'}"  ${seen}`);
    }
  }
  process.exit(0);
}

if (values.top) {
  // Saves per thousand views is the honest signal for this account: it survives a post
  // going viral with a low-intent audience, which raw likes does not.
  const scored = posts
    .map((p) => ({ post: p, m: newestMeasurement(p.id) }))
    .filter(({ m }) => m?.views > 0)
    .map(({ post, m }) => ({
      id: post.id,
      headline: post.copy?.headline ?? '',
      template: post.template, audience: post.audience,
      hookArchetype: post.hookArchetype, featureShown: post.featureShown,
      savesPer1k: m.saves == null ? null : Number(((m.saves / m.views) * 1000).toFixed(2)),
      likesPer1k: m.likes == null ? null : Number(((m.likes / m.views) * 1000).toFixed(2)),
      views: m.views,
    }))
    .sort((a, b) => (b.savesPer1k ?? b.likesPer1k ?? 0) - (a.savesPer1k ?? a.likesPer1k ?? 0));

  if (values.json) {
    console.log(JSON.stringify(scored, null, 2));
  } else if (!scored.length) {
    console.log('No measured posts yet. Record some numbers first.');
  } else {
    console.log('Best first, by saves per 1k views:\n');
    for (const row of scored.slice(0, 10)) {
      console.log(`  ${String(row.savesPer1k ?? '?').padStart(6)} saves/1k  ${String(row.likesPer1k ?? '?').padStart(6)} likes/1k  ${row.id}`);
      console.log(`         ${row.audience} / ${row.hookArchetype} / ${row.featureShown} / ${row.template}`);
    }
  }
  process.exit(0);
}

if (!values.post) {
  console.error('Pass --post <id> with numbers, or --pending, or --top.');
  process.exit(1);
}

const target = posts.find((p) => p.id === values.post);
if (!target) {
  console.error(`No post "${values.post}" in history.`);
  process.exit(1);
}

const row = {
  postId: values.post,
  measuredAt: now.toISOString(),
  daysSincePublish: target.publishedAt ? Number(daysBetween(now, target.publishedAt).toFixed(1)) : null,
  likes: num(values.likes),
  views: num(values.views),
  saves: num(values.saves),
  comments: num(values.comments),
  shares: num(values.shares),
  notes: values.notes ?? '',
  enteredBy: 'user-reported',
};

appendMetric(REPO_ROOT, row);
const given = Object.entries(row).filter(([k, v]) => v !== null && !['postId', 'measuredAt', 'enteredBy', 'notes'].includes(k));
console.log(`Recorded for ${values.post}: ${given.map(([k, v]) => `${k}=${v}`).join(', ')}`);
