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
    
    // Also store time periodically while video is playing
    let timeStoreInterval;
    document.addEventListener('DOMContentLoaded', () => {
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
    document.addEventListener('DOMContentLoaded', () => {
        const video = $('#background-video');
        if (video) {
            const storedTime = localStorage.getItem(BACKGROUND_VIDEO_KEY);

            // A <video> whose only <source> carries a non-matching media query selects
            // nothing — networkState settles at NETWORK_NO_SOURCE (3) and it can never
            // play. That is the NORMAL state on every phone: index.html gates
            // background.mp4 behind `media="(min-width: 769px)"` so mobile never spends
            // 1.25 MB on a decorative layer, and there the `poster` IS the intended
            // visual. So the "playback failed, fall back to a solid colour" paths below
            // must not fire — hiding the element would throw the poster away and leave a
            // flat #b2c4f6 page. Asked lazily, not once up front, because resource
            // selection is a queued task that may not have settled at DOMContentLoaded.
            const hasSource = () => video.networkState !== 3;
            const fallBackToSolid = () => {
                if (!hasSource()) return;
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
                if (!hasSource()) return;
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
