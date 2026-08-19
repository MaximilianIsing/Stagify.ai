// Background video sync for the main Stagify tool pages (scripts/app.js).
//
// Keeps the hero background video's playback position continuous across page
// navigations (localStorage) and retries autoplay around mobile restrictions,
// falling back to a solid background when playback never starts. Call
// initBackgroundVideoSync() at module eval — module scripts run before
// DOMContentLoaded, so the DOMContentLoaded/beforeunload/pagehide listeners
// below still register in time. No-ops on pages without #background-video.

export function initBackgroundVideoSync() {
  const $ = (sel) => document.querySelector(sel);

    // Background video synchronization across page navigation
    const BACKGROUND_VIDEO_KEY = 'stagify_background_video_time';
    
    // Store video currentTime when navigating away
    const storeVideoTime = () => {
        const video = $('#background-video');
        if (video && !video.paused) {
            localStorage.setItem(BACKGROUND_VIDEO_KEY, video.currentTime.toString());
        }
    };
    
    // Listen for various navigation events
    window.addEventListener('beforeunload', storeVideoTime);
    window.addEventListener('pagehide', storeVideoTime);
    
    /* RUN NOW IF THE DOCUMENT IS ALREADY PARSED, otherwise wait for it.
     *
     * This file used to register both of its blocks on a bare `DOMContentLoaded`, which
     * was fine while app.js was a <script type="module"> in <head> — modules execute
     * before that event. It stops being fine the moment app.js moves into
     * scripts/index-deferred.js's list, because everything injected there runs after
     * `load`: the event is long gone, the listener never fires, and NOTHING THROWS. The
     * backdrop simply never syncs or plays. index-deferred.js's header calls this out by
     * name as the trap of that list, and test/frontend/index-deferred.test.js fails any
     * deferred file that waits on an event without this branch.
     *
     * @param {() => void} fn
     */
    const onReady = (fn) => {
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
        else fn();
    };

    // Also store time periodically while video is playing
    let timeStoreInterval;
    onReady(() => {
        const video = $('#background-video');
        if (video) {
            video.addEventListener('play', () => {
                // Store time every 2 seconds while playing
                timeStoreInterval = setInterval(storeVideoTime, 2000);
            });
            
            video.addEventListener('pause', () => {
                if (timeStoreInterval) {
                    clearInterval(timeStoreInterval);
                }
            });
        }
    });
    
    // Restore video currentTime when page loads
    onReady(() => {
        const video = $('#background-video');
        if (video) {
            const storedTime = localStorage.getItem(BACKGROUND_VIDEO_KEY);

            // A <video> whose only <source> carries a non-matching media query selects
            // nothing and can never play. That is the NORMAL state on every phone:
            // index.html gates background.mp4 behind `media="(min-width: 769px)"` so
            // mobile never spends 1.25 MB on a decorative layer. The phone backdrop is
            // therefore painted in CSS instead (styles.css hides #background-video under
            // 769px and draws the poster on a fixed body::before, because the UA paints an
            // unremovable play glyph over a video it cannot start). So every path below is
            // desktop-only and must stay inert here: firing "playback failed, fall back to
            // a solid colour" on a phone would repaint the body over a backdrop that is
            // working as designed. Asked lazily, not once up front, because resource
            // selection is a queued task that may not have settled at DOMContentLoaded.
            //
            // THE TEST IS `currentSrc`, NOT `networkState`, and the difference is not
            // cosmetic. This used to read `networkState !== 3` (NETWORK_NO_SOURCE), which
            // was a correct reading of "nothing was selected" only while the element
            // carried `autoplay`. The homepage's <video> now ships `preload="none"` with
            // no `autoplay` so that background.mp4 stays out of the LCP window — and in
            // that state a desktop browser HAS selected a source but has not begun
            // loading it, so networkState settles at NETWORK_EMPTY/NETWORK_IDLE, not 3.
            // The old predicate therefore returned true, the retry loop below found the
            // video "still paused" one second later, and fallBackToSolid() threw away a
            // perfectly good backdrop for a flat #b2c4f6 page on every desktop visit.
            // `currentSrc` answers the question actually being asked — "did resource
            // selection pick anything?" — and is '' in exactly the no-source case.
            const hasSource = () => !!video.currentSrc;
            // HAS ANYONE ASKED THIS VIDEO TO PLAY YET? Every "playback failed" path below
            // reads "still paused" as "autoplay was blocked", which is only a sound
            // inference once a play has actually been attempted.
            //   - The ten non-homepage carriers still ship `autoplay`, so the browser
            //     attempts it itself and video.autoplay is the right answer immediately.
            //   - The homepage deliberately does NOT (see the comment on its <video>): it
            //     is started later by scripts/bg-video-start.js, which marks the element
            //     with data-bg-started first. Until that lands, "paused" is the INTENDED
            //     state and must not arm anything.
            // Without this the retry loop below reaches fallBackToSolid() one second into
            // every desktop homepage visit and replaces a working backdrop with flat blue.
            const startAttempted = () => video.autoplay || video.hasAttribute('data-bg-started');
            const fallBackToSolid = () => {
                if (!hasSource() || !startAttempted()) return;
                video.style.display = 'none';
                document.body.style.background = '#b2c4f6';
            };

            // Handle smooth video loading transition
            video.addEventListener('loadeddata', () => {
                video.classList.add('loaded');
            });

            // Ensure video starts playing smoothly
            video.addEventListener('canplay', () => {
                video.play().catch(() => {
                    // Handle autoplay restrictions gracefully - fallback to solid background
                    fallBackToSolid();
                });
            });

            // Handle mobile autoplay restrictions
            const attemptPlay = () => {
                if (!hasSource() || !startAttempted()) return;
                if (video.paused) {
                    video.play().catch(() => {
                        // Still failed, keep trying on user interaction
                        // If this is the final attempt, hide video and show solid background
                        if (playAttempts >= maxAttempts - 1) {
                            fallBackToSolid();
                        }
                    });
                }
            };
  
            // Try to play on various user interactions
            document.addEventListener('touchstart', attemptPlay, { once: true });
            document.addEventListener('click', attemptPlay, { once: true });
            document.addEventListener('scroll', attemptPlay, { once: true });
  
            // Also try periodically for mobile
            let playAttempts = 0;
            const maxAttempts = 1;
            const playInterval = setInterval(() => {
                if (!hasSource()) {
                    // Mobile, by design — nothing to play and nothing to fall back from.
                    clearInterval(playInterval);
                    return;
                }
                if (!video.paused) {
                    // Playing. Nothing left to retry, and nothing left to fall back from —
                    // the old code left this ticking forever on the happy path.
                    clearInterval(playInterval);
                    return;
                }
                // Not started on purpose (homepage, pre-bg-video-start.js). Keep waiting
                // WITHOUT spending an attempt, or the budget is gone before the deferred
                // starter has had a chance to run.
                if (!startAttempted()) return;
                if (video.paused && playAttempts < maxAttempts) {
                    attemptPlay();
                    playAttempts++;
                } else if (!video.paused || playAttempts >= maxAttempts) {
                    clearInterval(playInterval);
                    // If we've exhausted all attempts, hide video and show solid background
                    if (video.paused) {
                        fallBackToSolid();
                    }
                }
            }, 1000);
            
            if (storedTime) {
                const targetTime = parseFloat(storedTime);
                
                const restoreTime = () => {
                    if (video.duration && targetTime < video.duration) {
                        video.currentTime = targetTime;
                    }
                };
                
                // Try to restore time when metadata is loaded
                video.addEventListener('loadedmetadata', restoreTime);
                
                // Fallback if metadata is already loaded
                if (video.readyState >= 1 && video.duration) {
                    restoreTime();
                }
                
                // Additional fallback after a short delay
                setTimeout(restoreTime, 100);
            }
        }
    });
}
