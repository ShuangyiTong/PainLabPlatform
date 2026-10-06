/*
  Shuangyi Tong <shuangyi.tong@eng.ox.ac.uk>
  themes.js — theme palette data, split out of renderer.js.

  Pure data, no logic: renderer.js owns changeTheme(), which reads THEMES
  to write the custom properties onto :root and GLASS_THEMES to decide
  whether body gets the frosted-glass treatment. Loaded as a plain script
  before renderer.js (see index.html), so both names are globals by the
  time anything uses them.

  ===== Theme Palettes =====
  Each theme is a full multi-colour palette.
  Colours are assigned to specific UI regions so
  panels, buttons, and sections each get a distinct hue.

  Roles:
    accent / accent-hover / accent-light / accent-border  — tabs, focus ring, scrollbar, selection
    btn-primary / btn-primary-hover                       — Activate button
    tint-sidebar / tint-entry / tint-detail               — left-side & device detail panels
    tint-actions / tint-monitor / tint-interact            — right-side panels
    tint-tab-1 / tint-tab-2 / tint-tab-3                   — the three view tabs in the title bar
    panel-tint / panel-tint-strong                         — generic accent tint (button active, hover glow)
    shadow-focus                                           — focus-ring box-shadow

  The tint-tab-* trio is deliberately stronger (~0.14–0.20 alpha) than the
  panel tints (~0.05–0.08). They sit in the title bar rather than on a white
  card, and they have a job to do: making each tab visibly its own block, so
  the untinted drag strip beside the window buttons reads as empty space.
*/
const THEMES = {
    /* ── Rose Garden ─────────────────────────────────────
       Rose pink · Peach coral · Lavender · Sage green     */
    rose: {
        '--accent':            'rgb(223, 147, 148)',
        '--accent-hover':      'rgb(207, 125, 126)',
        '--accent-light':      'rgba(223, 147, 148, 0.10)',
        '--accent-border':     'rgba(223, 147, 148, 0.50)',
        '--btn-primary':       'rgb(192, 132, 115)',
        '--btn-primary-hover': 'rgb(170, 112, 95)',
        '--tint-sidebar':      'rgba(192, 165, 148, 0.08)',
        '--tint-entry':        'rgba(223, 147, 148, 0.05)',
        '--tint-detail':       'rgba(186, 148, 170, 0.06)',
        '--tint-actions':      'rgba(200, 165, 145, 0.07)',
        '--tint-monitor':      'rgba(155, 140, 180, 0.06)',
        '--tint-interact':     'rgba(145, 178, 148, 0.06)',
        '--tint-tab-1':        'rgba(223, 147, 148, 0.16)',
        '--tint-tab-2':        'rgba(155, 140, 180, 0.16)',
        '--tint-tab-3':        'rgba(145, 178, 148, 0.16)',
        '--panel-tint':        'rgba(223, 147, 148, 0.06)',
        '--panel-tint-strong': 'rgba(223, 147, 148, 0.12)',
        '--shadow-focus':      '0 0 0 3px rgba(223, 147, 148, 0.25)',
    },

    /* ── Ocean Breeze ────────────────────────────────────
       Teal · Navy · Sea-foam green · Warm sand            */
    ocean: {
        '--accent':            'rgb(52, 144, 176)',
        '--accent-hover':      'rgb(36, 120, 152)',
        '--accent-light':      'rgba(52, 144, 176, 0.10)',
        '--accent-border':     'rgba(52, 144, 176, 0.50)',
        '--btn-primary':       'rgb(48, 100, 140)',
        '--btn-primary-hover': 'rgb(36, 82, 120)',
        '--tint-sidebar':      'rgba(70, 130, 160, 0.07)',
        '--tint-entry':        'rgba(80, 160, 190, 0.05)',
        '--tint-detail':       'rgba(52, 144, 176, 0.06)',
        '--tint-actions':      'rgba(100, 140, 160, 0.07)',
        '--tint-monitor':      'rgba(130, 190, 160, 0.07)',
        '--tint-interact':     'rgba(200, 185, 155, 0.08)',
        '--tint-tab-1':        'rgba(52, 144, 176, 0.14)',
        '--tint-tab-2':        'rgba(130, 190, 160, 0.16)',
        '--tint-tab-3':        'rgba(200, 185, 155, 0.20)',
        '--panel-tint':        'rgba(52, 144, 176, 0.06)',
        '--panel-tint-strong': 'rgba(52, 144, 176, 0.12)',
        '--shadow-focus':      '0 0 0 3px rgba(52, 144, 176, 0.25)',
    },

    /* ── Forest Canopy ───────────────────────────────────
       Emerald · Moss · Warm earth · Amber                 */
    forest: {
        '--accent':            'rgb(72, 148, 104)',
        '--accent-hover':      'rgb(52, 125, 82)',
        '--accent-light':      'rgba(72, 148, 104, 0.10)',
        '--accent-border':     'rgba(72, 148, 104, 0.50)',
        '--btn-primary':       'rgb(110, 130, 80)',
        '--btn-primary-hover': 'rgb(90, 110, 62)',
        '--tint-sidebar':      'rgba(120, 140, 100, 0.07)',
        '--tint-entry':        'rgba(72, 148, 104, 0.05)',
        '--tint-detail':       'rgba(140, 120, 90, 0.06)',
        '--tint-actions':      'rgba(100, 130, 90, 0.07)',
        '--tint-monitor':      'rgba(100, 140, 120, 0.07)',
        '--tint-interact':     'rgba(190, 165, 105, 0.07)',
        '--tint-tab-1':        'rgba(72, 148, 104, 0.14)',
        '--tint-tab-2':        'rgba(140, 120, 90, 0.16)',
        '--tint-tab-3':        'rgba(190, 165, 105, 0.20)',
        '--panel-tint':        'rgba(72, 148, 104, 0.06)',
        '--panel-tint-strong': 'rgba(72, 148, 104, 0.12)',
        '--shadow-focus':      '0 0 0 3px rgba(72, 148, 104, 0.25)',
    },

    /* ── Dusk ────────────────────────────────────────────
       Amethyst · Indigo · Wisteria · Rose-gold            */
    dusk: {
        '--accent':            'rgb(136, 100, 185)',
        '--accent-hover':      'rgb(114, 78, 165)',
        '--accent-light':      'rgba(136, 100, 185, 0.10)',
        '--accent-border':     'rgba(136, 100, 185, 0.50)',
        '--btn-primary':       'rgb(100, 80, 160)',
        '--btn-primary-hover': 'rgb(82, 62, 140)',
        '--tint-sidebar':      'rgba(130, 110, 170, 0.07)',
        '--tint-entry':        'rgba(136, 100, 185, 0.05)',
        '--tint-detail':       'rgba(170, 130, 160, 0.06)',
        '--tint-actions':      'rgba(120, 100, 160, 0.07)',
        '--tint-monitor':      'rgba(100, 120, 175, 0.07)',
        '--tint-interact':     'rgba(200, 155, 145, 0.07)',
        '--tint-tab-1':        'rgba(136, 100, 185, 0.14)',
        '--tint-tab-2':        'rgba(100, 120, 175, 0.16)',
        '--tint-tab-3':        'rgba(200, 155, 145, 0.18)',
        '--panel-tint':        'rgba(136, 100, 185, 0.06)',
        '--panel-tint-strong': 'rgba(136, 100, 185, 0.12)',
        '--shadow-focus':      '0 0 0 3px rgba(136, 100, 185, 0.25)',
    },

    /* ── Amber Glow ──────────────────────────────────────
       Golden amber · Rust · Khaki · Terracotta            */
    amber: {
        '--accent':            'rgb(200, 150, 50)',
        '--accent-hover':      'rgb(178, 128, 32)',
        '--accent-light':      'rgba(200, 150, 50, 0.10)',
        '--accent-border':     'rgba(200, 150, 50, 0.50)',
        '--btn-primary':       'rgb(180, 110, 70)',
        '--btn-primary-hover': 'rgb(158, 90, 52)',
        '--tint-sidebar':      'rgba(200, 170, 120, 0.07)',
        '--tint-entry':        'rgba(200, 150, 50, 0.05)',
        '--tint-detail':       'rgba(180, 130, 80, 0.06)',
        '--tint-actions':      'rgba(190, 160, 100, 0.07)',
        '--tint-monitor':      'rgba(145, 135, 100, 0.07)',
        '--tint-interact':     'rgba(170, 100, 80, 0.07)',
        '--tint-tab-1':        'rgba(200, 150, 50, 0.16)',
        '--tint-tab-2':        'rgba(145, 135, 100, 0.16)',
        '--tint-tab-3':        'rgba(170, 100, 80, 0.16)',
        '--panel-tint':        'rgba(200, 150, 50, 0.06)',
        '--panel-tint-strong': 'rgba(200, 150, 50, 0.12)',
        '--shadow-focus':      '0 0 0 3px rgba(200, 150, 50, 0.25)',
    },
    
    /* Seaborn themes: colour sampled from Seaborn palette*/

    /* ── Flare (Glass) ─────────────────────────────────
       Warm peach → Coral → Rose-magenta → Deep plum      */
    flare: {
        '--accent':            'rgb(202, 68, 100)',
        '--accent-hover':      'rgb(185, 61, 106)',
        '--accent-light':      'rgba(202, 68, 100, 0.10)',
        '--accent-border':     'rgba(202, 68, 100, 0.50)',
        '--btn-primary':       'rgb(147, 51, 112)',
        '--btn-primary-hover': 'rgb(129, 47, 112)',
        '--tint-sidebar':      'rgba(235, 157, 117, 0.08)',
        '--tint-entry':        'rgba(233, 137, 105, 0.05)',
        '--tint-detail':       'rgba(166, 56, 110, 0.06)',
        '--tint-actions':      'rgba(229, 118, 96, 0.07)',
        '--tint-monitor':      'rgba(92, 39, 103, 0.07)',
        '--tint-interact':     'rgba(224, 99, 91, 0.06)',
        '--tint-tab-1':        'rgba(235, 157, 117, 0.20)',
        '--tint-tab-2':        'rgba(202, 68, 100, 0.14)',
        '--tint-tab-3':        'rgba(92, 39, 103, 0.14)',
        '--panel-tint':        'rgba(202, 68, 100, 0.06)',
        '--panel-tint-strong': 'rgba(202, 68, 100, 0.12)',
        '--shadow-focus':      '0 0 0 3px rgba(202, 68, 100, 0.25)',
    },

    /* ── Mako (Glass) ──────────────────────────────────
       Deep indigo → Ocean blue → Teal → Mint green        */
    mako: {
        '--accent':            'rgb(52, 155, 169)',
        '--accent-hover':      'rgb(52, 132, 165)',
        '--accent-light':      'rgba(52, 155, 169, 0.10)',
        '--accent-border':     'rgba(52, 155, 169, 0.50)',
        '--btn-primary':       'rgb(64, 65, 131)',
        '--btn-primary-hover': 'rgb(60, 48, 98)',
        '--tint-sidebar':      'rgba(182, 229, 197, 0.08)',
        '--tint-entry':        'rgba(80, 198, 172, 0.05)',
        '--tint-detail':       'rgba(58, 88, 153, 0.06)',
        '--tint-actions':      'rgba(130, 215, 176, 0.07)',
        '--tint-monitor':      'rgba(53, 111, 160, 0.07)',
        '--tint-interact':     'rgba(60, 177, 172, 0.06)',
        '--tint-tab-1':        'rgba(182, 229, 197, 0.22)',
        '--tint-tab-2':        'rgba(52, 155, 169, 0.16)',
        '--tint-tab-3':        'rgba(64, 65, 131, 0.14)',
        '--panel-tint':        'rgba(52, 155, 169, 0.06)',
        '--panel-tint-strong': 'rgba(52, 155, 169, 0.12)',
        '--shadow-focus':      '0 0 0 3px rgba(52, 155, 169, 0.25)',
    },

    /* ── Rocket (Glass) ────────────────────────────────
       Deep purple → Hot magenta → Fiery red → Peach       */
    rocket: {
        '--accent':            'rgb(234, 70, 61)',
        '--accent-hover':      'rgb(215, 37, 72)',
        '--accent-light':      'rgba(234, 70, 61, 0.10)',
        '--accent-border':     'rgba(234, 70, 61, 0.50)',
        '--btn-primary':       'rgb(154, 26, 91)',
        '--btn-primary-hover': 'rgb(120, 30, 88)',
        '--tint-sidebar':      'rgba(247, 206, 179, 0.08)',
        '--tint-entry':        'rgba(246, 175, 137, 0.05)',
        '--tint-detail':       'rgba(187, 22, 85, 0.06)',
        '--tint-actions':      'rgba(244, 142, 101, 0.07)',
        '--tint-monitor':      'rgba(89, 30, 80, 0.07)',
        '--tint-interact':     'rgba(242, 109, 74, 0.06)',
        '--tint-tab-1':        'rgba(247, 206, 179, 0.22)',
        '--tint-tab-2':        'rgba(234, 70, 61, 0.14)',
        '--tint-tab-3':        'rgba(89, 30, 80, 0.14)',
        '--panel-tint':        'rgba(234, 70, 61, 0.06)',
        '--panel-tint-strong': 'rgba(234, 70, 61, 0.12)',
        '--shadow-focus':      '0 0 0 3px rgba(234, 70, 61, 0.25)',
    },

    /* ── Icefire (Glass) ───────────────────────────────
       Ice blue → Deep dark → Fire red → Warm amber
       Diverging: cold tints on left panels, warm on right */
    icefire: {
        '--accent':            'rgb(77, 157, 205)',
        '--accent-hover':      'rgb(57, 114, 206)',
        '--accent-light':      'rgba(77, 157, 205, 0.10)',
        '--accent-border':     'rgba(77, 157, 205, 0.50)',
        '--btn-primary':       'rgb(194, 57, 60)',
        '--btn-primary-hover': 'rgb(141, 45, 67)',
        '--tint-sidebar':      'rgba(134, 194, 207, 0.08)',
        '--tint-entry':        'rgba(77, 157, 205, 0.05)',
        '--tint-detail':       'rgba(57, 114, 206, 0.06)',
        '--tint-actions':      'rgba(244, 159, 102, 0.07)',
        '--tint-monitor':      'rgba(229, 102, 51, 0.07)',
        '--tint-interact':     'rgba(194, 57, 60, 0.06)',
        '--tint-tab-1':        'rgba(134, 194, 207, 0.20)',
        '--tint-tab-2':        'rgba(244, 159, 102, 0.18)',
        '--tint-tab-3':        'rgba(194, 57, 60, 0.14)',
        '--panel-tint':        'rgba(77, 157, 205, 0.06)',
        '--panel-tint-strong': 'rgba(77, 157, 205, 0.12)',
        '--shadow-focus':      '0 0 0 3px rgba(77, 157, 205, 0.25)',
    },

    /* ── Spectral (Glass) ──────────────────────────────
       Crimson → Orange → Gold → Spring green → Teal → Blue
       Uses the full rainbow across the UI                  */
    spectral: {
        '--accent':            'rgb(77, 166, 176)',
        '--accent-hover':      'rgb(61, 121, 182)',
        '--accent-light':      'rgba(77, 166, 176, 0.10)',
        '--accent-border':     'rgba(77, 166, 176, 0.50)',
        '--btn-primary':       'rgb(198, 46, 75)',
        '--btn-primary-hover': 'rgb(172, 38, 62)',
        '--tint-sidebar':      'rgba(253, 216, 132, 0.08)',
        '--tint-entry':        'rgba(220, 241, 153, 0.06)',
        '--tint-detail':       'rgba(123, 202, 164, 0.06)',
        '--tint-actions':      'rgba(253, 176, 99, 0.07)',
        '--tint-monitor':      'rgba(61, 121, 182, 0.07)',
        '--tint-interact':     'rgba(229, 86, 72, 0.06)',
        '--tint-tab-1':        'rgba(253, 216, 132, 0.24)',
        '--tint-tab-2':        'rgba(123, 202, 164, 0.20)',
        '--tint-tab-3':        'rgba(61, 121, 182, 0.16)',
        '--panel-tint':        'rgba(77, 166, 176, 0.06)',
        '--panel-tint-strong': 'rgba(77, 166, 176, 0.12)',
        '--shadow-focus':      '0 0 0 3px rgba(77, 166, 176, 0.25)',
    },

    /* ── Pastel (seaborn "pastel") ───────────────────────
       Soft blue · peach · mint · salmon · lilac · pink     */
    pastel: {
        '--accent':            'rgb(120, 168, 214)',
        '--accent-hover':      'rgb(82, 132, 182)',
        '--accent-light':      'rgba(161, 201, 244, 0.18)',
        '--accent-border':     'rgba(161, 201, 244, 0.75)',
        '--btn-primary':       'rgb(214, 118, 114)',
        '--btn-primary-hover': 'rgb(188, 94, 90)',
        '--tint-sidebar':      'rgba(161, 201, 244, 0.10)',
        '--tint-entry':        'rgba(141, 229, 161, 0.10)',
        '--tint-detail':       'rgba(208, 187, 255, 0.12)',
        '--tint-actions':      'rgba(255, 180, 130, 0.12)',
        '--tint-monitor':      'rgba(185, 242, 240, 0.16)',
        '--tint-interact':     'rgba(250, 176, 228, 0.12)',
        '--tint-tab-1':        'rgba(161, 201, 244, 0.32)',
        '--tint-tab-2':        'rgba(255, 180, 130, 0.32)',
        '--tint-tab-3':        'rgba(141, 229, 161, 0.32)',
        '--panel-tint':        'rgba(161, 201, 244, 0.09)',
        '--panel-tint-strong': 'rgba(161, 201, 244, 0.18)',
        '--shadow-focus':      '0 0 0 3px rgba(161, 201, 244, 0.40)',
    },

    /* ── Muted (seaborn "muted") ─────────────────────────
       Slate blue · orange · green · brick · purple · cyan  */
    muted: {
        '--accent':            'rgb(72, 120, 208)',
        '--accent-hover':      'rgb(54, 96, 176)',
        '--accent-light':      'rgba(72, 120, 208, 0.10)',
        '--accent-border':     'rgba(72, 120, 208, 0.50)',
        '--btn-primary':       'rgb(214, 95, 95)',
        '--btn-primary-hover': 'rgb(186, 74, 74)',
        '--tint-sidebar':      'rgba(121, 121, 121, 0.07)',
        '--tint-entry':        'rgba(72, 120, 208, 0.06)',
        '--tint-detail':       'rgba(149, 108, 180, 0.07)',
        '--tint-actions':      'rgba(238, 133, 74, 0.08)',
        '--tint-monitor':      'rgba(106, 204, 100, 0.08)',
        '--tint-interact':     'rgba(130, 198, 226, 0.10)',
        '--tint-tab-1':        'rgba(72, 120, 208, 0.16)',
        '--tint-tab-2':        'rgba(106, 204, 100, 0.18)',
        '--tint-tab-3':        'rgba(238, 133, 74, 0.18)',
        '--panel-tint':        'rgba(72, 120, 208, 0.06)',
        '--panel-tint-strong': 'rgba(72, 120, 208, 0.12)',
        '--shadow-focus':      '0 0 0 3px rgba(72, 120, 208, 0.25)',
    },

    /* ── Set2 (ColorBrewer, via seaborn "Set2") ──────────
       Muted qualitative eight: teal · orange · periwinkle
       · pink · lime · yellow · tan · grey                  */
    set2: {
        '--accent':            'rgb(86, 178, 149)',
        '--accent-hover':      'rgb(60, 144, 118)',
        '--accent-light':      'rgba(102, 194, 165, 0.16)',
        '--accent-border':     'rgba(102, 194, 165, 0.65)',
        '--btn-primary':       'rgb(219, 108, 68)',
        '--btn-primary-hover': 'rgb(192, 89, 52)',
        '--tint-sidebar':      'rgba(179, 179, 179, 0.08)',
        '--tint-entry':        'rgba(102, 194, 165, 0.08)',
        '--tint-detail':       'rgba(141, 160, 203, 0.09)',
        '--tint-actions':      'rgba(229, 196, 148, 0.12)',
        '--tint-monitor':      'rgba(166, 216, 84, 0.10)',
        '--tint-interact':     'rgba(231, 138, 195, 0.09)',
        '--tint-tab-1':        'rgba(102, 194, 165, 0.24)',
        '--tint-tab-2':        'rgba(252, 141, 98, 0.22)',
        '--tint-tab-3':        'rgba(141, 160, 203, 0.24)',
        '--panel-tint':        'rgba(102, 194, 165, 0.08)',
        '--panel-tint-strong': 'rgba(102, 194, 165, 0.16)',
        '--shadow-focus':      '0 0 0 3px rgba(102, 194, 165, 0.30)',
    },
};

/* Menu display names for the palettes whose key doesn't just capitalise
   nicely. Anything absent falls back to capitalising the key. */
const THEME_LABELS = {
    husl: 'HUSL',
    set2: 'Set2'
};

/* Palettes that switch on the frosted-glass treatment (body.glass). */
const GLASS_THEMES = new Set(['flare', 'mako', 'rocket', 'spectral', 'pastel']);
