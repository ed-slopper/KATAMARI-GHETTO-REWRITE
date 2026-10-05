
// Entry point: boots straight into one Katamari Damacy map and lets you roll around.

import { Viewer } from '../viewer.js';
import { DataFetcher } from '../DataFetcher.js';
import { DataShare } from '../DataShare.js';
import { createSwapChainForWebGL2, GfxPlatformWebGL2Config } from '../gfx/platform/GfxPlatformWebGL2.js';
import { AntialiasingMode } from '../gfx/helpers/RenderGraphHelpers.js';
import { KatamariDamacyRenderer, KatamariLevelSceneDesc } from '../KatamariDamacy/scenes.js';
import { SceneContext } from '../SceneBase.js';
import { KatamariGame } from './game.js';

function formatSize(cm: number): string {
    const m = Math.floor(cm / 100);
    const c = Math.floor(cm - m * 100);
    const mm = Math.floor((cm - Math.floor(cm)) * 10);
    if (m >= 100)
        return `${m}m`;
    if (m > 0)
        return `${m}m ${c}cm`;
    return `${c}cm ${mm}mm`;
}

async function main() {
    const status = document.getElementById('status')!;
    const hud = document.getElementById('hud')!;
    const sizeEl = document.getElementById('size')!;
    const countEl = document.getElementById('count')!;
    const help = document.getElementById('help')!;
    const canvas = document.getElementById('canvas') as HTMLCanvasElement;

    const fail = (msg: string) => { status.textContent = msg; status.classList.add('error'); };

    const gl = canvas.getContext('webgl2', { antialias: false, preserveDrawingBuffer: false, depth: false, stencil: false });
    if (!gl) {
        fail('This browser does not support WebGL 2, which the game needs.');
        return;
    }
    const swapChain = createSwapChainForWebGL2(gl, new GfxPlatformWebGL2Config());
    const viewer = new Viewer(swapChain, canvas);
    viewer.viewerRenderInput.antialiasingMode = AntialiasingMode.FXAA;
    (viewer.inputManager as any).usePointerLock = false;
    const device = viewer.gfxDevice;

    const resize = () => {
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const w = Math.max(1, Math.floor(window.innerWidth * dpr)), h = Math.max(1, Math.floor(window.innerHeight * dpr));
        if (canvas.width !== w || canvas.height !== h) {
            canvas.width = w;
            canvas.height = h;
        }
    };
    resize();
    window.addEventListener('resize', resize);

    const progressMeter = {
        loadProgress: 0,
        setProgress(p: number) {
            this.loadProgress = p;
            status.textContent = `Loading the world… ${Math.round(p * 100)}%`;
        },
    };
    const dataFetcher = new DataFetcher(progressMeter);
    await dataFetcher.init();

    const context: SceneContext = {
        device, dataFetcher,
        dataShare: new DataShare(),
        uiContainer: document.createElement('div'),
        destroyablePool: [],
        inputManager: viewer.inputManager,
        viewerInput: viewer.viewerRenderInput,
        sceneLoader: { loadSceneById() {} },
        initialSceneTime: 0,
    };

    let scene: KatamariDamacyRenderer;
    try {
        // Make the Moon: the one map that goes from tabletop-sized to island-sized.
        const desc = new KatamariLevelSceneDesc('lvl10', 10, 'World');
        scene = await desc.createScene(device, context) as KatamariDamacyRenderer;
    } catch (e) {
        console.error(e);
        fail('Could not load the map data from noclip.website. Check your internet connection and reload.');
        return;
    }

    viewer.setScene(scene);
    const game = new KatamariGame(device, scene);
    viewer.setCameraController(game);
    (window as any).game = game;
    (window as any).viewer = viewer;

    // Things added to the map by hand: the MAP_ADDITIONS list at the top of this HTML file, plus build-mode placements.
    const additions = (window as any).MAP_ADDITIONS;
    game.loadAdditions(Array.isArray(additions) ? additions : []);

    const buildEl = document.getElementById('build')!;
    const flash = document.getElementById('flash')!;
    let lastBuild = '', lastHit = game.lastHitTime;
    status.remove();
    hud.hidden = false;
    let lastSize = '', lastCount = -1;
    game.onhud = (g) => {
        const s = formatSize(g.diameter);
        if (s !== lastSize) { sizeEl.textContent = s; lastSize = s; }
        if (g.buildText !== lastBuild) { buildEl.textContent = g.buildText; buildEl.hidden = g.buildText === ''; lastBuild = g.buildText; }
        if (g.lastHitTime !== lastHit) {
            lastHit = g.lastHitTime;
            flash.classList.remove('on');
            void flash.offsetWidth;
            flash.classList.add('on');
        }
        if (g.collectedCount !== lastCount) { countEl.textContent = `${g.collectedCount} things`; lastCount = g.collectedCount; }
    };
    const hideHelp = () => { help.classList.add('gone'); };
    window.addEventListener('keydown', () => window.setTimeout(hideHelp, 4000), { once: true });

    const frame = (time: number) => {
        resize();
        viewer.update({ time, webXRContext: null });
        window.requestAnimationFrame(frame);
    };
    viewer.rafTime = window.performance.now();
    window.requestAnimationFrame(frame);
}

main().catch((e) => {
    console.error(e);
    const status = document.getElementById('status');
    if (status) {
        status.textContent = 'Something went wrong starting the game: ' + (e && e.message ? e.message : e);
        status.classList.add('error');
    }
});
