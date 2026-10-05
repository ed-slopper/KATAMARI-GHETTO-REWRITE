
// Roll-around game layer on top of noclip's Katamari Damacy scene renderer.

import { mat4, quat, vec3 } from 'gl-matrix';
import { Camera, CameraController, CameraUpdateResult } from '../Camera.js';
import { colorNewFromRGBA } from '../Color.js';
import { AABB } from '../Geometry.js';
import { GfxDevice } from '../gfx/platform/GfxPlatform.js';
import { GfxRenderInstManager, GfxRendererLayer } from '../gfx/render/GfxRenderInstManager.js';
import InputManager from '../InputManager.js';
import * as BIN from '../KatamariDamacy/bin.js';
import { KDLayer, ObjectRenderer } from '../KatamariDamacy/objects.js';
import { BINModelInstance, BINModelSectorData } from '../KatamariDamacy/render.js';
import { KatamariDamacyRenderer } from '../KatamariDamacy/scenes.js';
import { ViewerRenderInput } from '../viewer.js';

// Katamari space is Y-down; noclip space is that rotated by PI around X: (x, -y, -z). Self-inverse.
const toNoclip = mat4.create();
mat4.rotateX(toNoclip, toNoclip, Math.PI);

// Ball diameter (cm) at which each larger area of the map takes over.
const AREA_THRESHOLDS = [300, 1000, 3000, 12000];
// An object can be rolled up when its "size" (cube root of its bounding volume) is under this fraction of the ball's diameter.
const PICKUP_RATIO = 0.4;
// How much of an object's bounding volume gets added to the ball.
const GROWTH = 1.5;
const START_DIAMETER = 100;
// Visible core ball radius relative to the collision radius.
const CORE_RATIO = 0.8;
const MAX_VISIBLE_STUCK = 220;

class CollisionMesh {
    public tris: Float32Array; // 9 floats per triangle, noclip space
    public count: number;
    private cellSize: number;
    private minX: number; private minZ: number;
    private nx: number; private nz: number;
    private cellStart: Int32Array;
    private cellTris: Int32Array;
    private stamp: Int32Array;
    private stampCounter = 0;
    public result: Int32Array;
    public resultCount = 0;
    public minY = Infinity;
    public maxY = -Infinity;

    constructor(lists: BIN.CollisionList[]) {
        const out: number[] = [];
        for (const list of lists) {
            for (const g of list.groups) {
                const v = g.vertices;
                const n = v.length / 4;
                if (g.isTriStrip) {
                    for (let i = 2; i < n; i++) {
                        const a = (i - 2) * 4, b = (i - 1) * 4, c = i * 4;
                        if (i & 1)
                            out.push(v[b], -v[b + 1], -v[b + 2], v[a], -v[a + 1], -v[a + 2], v[c], -v[c + 1], -v[c + 2]);
                        else
                            out.push(v[a], -v[a + 1], -v[a + 2], v[b], -v[b + 1], -v[b + 2], v[c], -v[c + 1], -v[c + 2]);
                    }
                } else {
                    for (let i = 0; i + 2 < n; i += 3) {
                        const a = i * 4, b = a + 4, c = a + 8;
                        out.push(v[a], -v[a + 1], -v[a + 2], v[b], -v[b + 1], -v[b + 2], v[c], -v[c + 1], -v[c + 2]);
                    }
                }
            }
        }
        this.tris = new Float32Array(out);
        this.count = out.length / 9;
        const t = this.tris;

        let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
        for (let i = 0; i < t.length; i += 3) {
            minX = Math.min(minX, t[i]); maxX = Math.max(maxX, t[i]);
            minZ = Math.min(minZ, t[i + 2]); maxZ = Math.max(maxZ, t[i + 2]);
            this.minY = Math.min(this.minY, t[i + 1]); this.maxY = Math.max(this.maxY, t[i + 1]);
        }
        const GRID = 96;
        this.cellSize = Math.max(maxX - minX, maxZ - minZ, 1) / GRID;
        this.minX = minX; this.minZ = minZ;
        this.nx = Math.floor((maxX - minX) / this.cellSize) + 1;
        this.nz = Math.floor((maxZ - minZ) / this.cellSize) + 1;

        const counts = new Int32Array(this.nx * this.nz + 1);
        const forCells = (i: number, cb: (cell: number) => void) => {
            const o = i * 9;
            const x0 = this.cx(Math.min(t[o], t[o + 3], t[o + 6])), x1 = this.cx(Math.max(t[o], t[o + 3], t[o + 6]));
            const z0 = this.cz(Math.min(t[o + 2], t[o + 5], t[o + 8])), z1 = this.cz(Math.max(t[o + 2], t[o + 5], t[o + 8]));
            for (let z = z0; z <= z1; z++)
                for (let x = x0; x <= x1; x++)
                    cb(z * this.nx + x);
        };
        for (let i = 0; i < this.count; i++)
            forCells(i, (c) => { counts[c + 1]++; });
        for (let i = 0; i < this.nx * this.nz; i++)
            counts[i + 1] += counts[i];
        this.cellStart = counts;
        this.cellTris = new Int32Array(counts[this.nx * this.nz]);
        const fill = new Int32Array(this.nx * this.nz);
        for (let i = 0; i < this.count; i++)
            forCells(i, (c) => { this.cellTris[this.cellStart[c] + fill[c]++] = i; });
        this.stamp = new Int32Array(this.count);
        this.result = new Int32Array(this.count);
    }

    private cx(x: number): number { return Math.min(this.nx - 1, Math.max(0, Math.floor((x - this.minX) / this.cellSize))); }
    private cz(z: number): number { return Math.min(this.nz - 1, Math.max(0, Math.floor((z - this.minZ) / this.cellSize))); }

    // Collect candidate triangles overlapping an XZ box into this.result.
    public query(x0: number, z0: number, x1: number, z1: number): number {
        const s = ++this.stampCounter;
        let n = 0;
        const cx0 = this.cx(x0), cx1 = this.cx(x1), cz0 = this.cz(z0), cz1 = this.cz(z1);
        for (let z = cz0; z <= cz1; z++) {
            for (let x = cx0; x <= cx1; x++) {
                const c = z * this.nx + x;
                for (let k = this.cellStart[c]; k < this.cellStart[c + 1]; k++) {
                    const ti = this.cellTris[k];
                    if (this.stamp[ti] !== s) {
                        this.stamp[ti] = s;
                        this.result[n++] = ti;
                    }
                }
            }
        }
        this.resultCount = n;
        return n;
    }

    // Highest surface at (x, z) that is at or below fromY. Returns -Infinity if there is none.
    public groundHeight(x: number, z: number, fromY: number): number {
        const n = this.query(x, z, x, z);
        const t = this.tris;
        let best = -Infinity;
        for (let i = 0; i < n; i++) {
            const o = this.result[i] * 9;
            const ax = t[o], az = t[o + 2], bx = t[o + 3], bz = t[o + 5], cx = t[o + 6], cz = t[o + 8];
            const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
            if (Math.abs(d) < 1e-9)
                continue;
            const u = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d;
            const v = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d;
            const w = 1 - u - v;
            if (u < 0 || v < 0 || w < 0)
                continue;
            const y = u * t[o + 1] + v * t[o + 4] + w * t[o + 7];
            if (y <= fromY && y > best)
                best = y;
        }
        return best;
    }
}

const cp = vec3.create();
// Closest point on triangle (a, b, c) to p; Ericson, Real-Time Collision Detection.
function closestPointOnTriangle(out: vec3, px: number, py: number, pz: number, t: Float32Array, o: number): void {
    const ax = t[o], ay = t[o + 1], az = t[o + 2];
    const bx = t[o + 3], by = t[o + 4], bz = t[o + 5];
    const cx = t[o + 6], cy = t[o + 7], cz = t[o + 8];
    const abx = bx - ax, aby = by - ay, abz = bz - az;
    const acx = cx - ax, acy = cy - ay, acz = cz - az;
    const apx = px - ax, apy = py - ay, apz = pz - az;
    const d1 = abx * apx + aby * apy + abz * apz;
    const d2 = acx * apx + acy * apy + acz * apz;
    if (d1 <= 0 && d2 <= 0) { vec3.set(out, ax, ay, az); return; }
    const bpx = px - bx, bpy = py - by, bpz = pz - bz;
    const d3 = abx * bpx + aby * bpy + abz * bpz;
    const d4 = acx * bpx + acy * bpy + acz * bpz;
    if (d3 >= 0 && d4 <= d3) { vec3.set(out, bx, by, bz); return; }
    const vc = d1 * d4 - d3 * d2;
    if (vc <= 0 && d1 >= 0 && d3 <= 0) {
        const v = d1 / (d1 - d3);
        vec3.set(out, ax + abx * v, ay + aby * v, az + abz * v); return;
    }
    const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
    const d5 = abx * cpx + aby * cpy + abz * cpz;
    const d6 = acx * cpx + acy * cpy + acz * cpz;
    if (d6 >= 0 && d5 <= d6) { vec3.set(out, cx, cy, cz); return; }
    const vb = d5 * d2 - d1 * d6;
    if (vb <= 0 && d2 >= 0 && d6 <= 0) {
        const w = d2 / (d2 - d6);
        vec3.set(out, ax + acx * w, ay + acy * w, az + acz * w); return;
    }
    const va = d3 * d6 - d5 * d4;
    if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) {
        const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
        vec3.set(out, bx + (cx - bx) * w, by + (cy - by) * w, bz + (cz - bz) * w); return;
    }
    const denom = 1 / (va + vb + vc);
    const v = vb * denom, w = vc * denom;
    vec3.set(out, ax + abx * v + acx * w, ay + aby * v + acy * w, az + abz * v + acz * w);
}

interface GameObject {
    renderer: ObjectRenderer;
    index: number;
    volume: number;
    size: number;       // cube root of the bounding volume
    boundRadius: number;
    solid: boolean;
    children: GameObject[];
    stuck: boolean;
    local: mat4 | null; // transform relative to the ball, when stuck
    attachRadius: number;
    // Knocked off the ball (or placed by hand): we drive its transform ourselves.
    loose: LooseState | null;
    noCollectUntil: number;
    // Recent speed of things that move on their own (cars, people, animals...), cm/s.
    lastCenter: vec3 | null;
    lastCenterTime: number;
    moveSpeed: number;
    placed: boolean;
}

interface LooseState {
    pos: vec3;      // noclip space, object origin
    vel: vec3;
    rot: mat4;      // noclip space rotation
    axis: vec3;
    spinRate: number;
    resting: boolean;
}

// One thing added to the map by hand. Positions are in centimetres, y is up.
export interface MapAddition {
    id: number;     // object type id
    x: number;
    y: number;      // roughly the ground height there; the object is dropped onto the ground at or below this
    z: number;
    yaw?: number;   // radians
}

function makeBallSector(gsConfiguration: BIN.GSConfiguration): BIN.BINModelSector {
    // Texture: an original spotted pattern, so the rolling reads clearly.
    const W = 256, H = 128;
    const pixels = new Uint8Array(W * H * 4);
    const palette = [[38, 166, 154], [255, 138, 76], [240, 98, 146], [124, 179, 66], [92, 107, 192], [255, 202, 40]];
    const ROWS = 6;
    for (let y = 0; y < H; y++) {
        const lat = (y + 0.5) / H; // 0..1 pole to pole
        const row = Math.min(ROWS - 1, Math.floor(lat * ROWS));
        const rowCenter = (row + 0.5) / ROWS;
        const ring = Math.sin(rowCenter * Math.PI);
        const cols = Math.max(3, Math.round(12 * ring));
        for (let x = 0; x < W; x++) {
            const lon = (x + 0.5) / W + (row & 1) * 0.5 / cols;
            const col = Math.floor(lon * cols);
            const dx = ((lon * cols) - col - 0.5) / cols * 2 * Math.PI * ring;
            const dy = (lat - rowCenter) * Math.PI;
            const d = Math.hypot(dx, dy);
            let r = 250, g = 240, b = 215;
            const dotR = 0.17;
            if (d < dotR) {
                const c = palette[(col + row * 2) % palette.length];
                const shade = d < dotR * 0.55 ? 1.0 : 0.82;
                r = c[0] * shade; g = c[1] * shade; b = c[2] * shade;
            } else if (d < dotR + 0.025) {
                r = 110; g = 90; b = 80;
            }
            const o = (y * W + x) * 4;
            pixels[o] = r; pixels[o + 1] = g; pixels[o + 2] = b; pixels[o + 3] = 255;
        }
    }

    const SEG = 32, RING = 20;
    const vertexData = new Float32Array((SEG + 1) * (RING + 1) * 9);
    let vo = 0;
    for (let j = 0; j <= RING; j++) {
        const phi = j / RING * Math.PI;
        for (let i = 0; i <= SEG; i++) {
            const th = i / SEG * Math.PI * 2;
            const x = Math.sin(phi) * Math.cos(th), y = Math.cos(phi), z = Math.sin(phi) * Math.sin(th);
            vertexData[vo++] = x; vertexData[vo++] = y; vertexData[vo++] = z; vertexData[vo++] = 0;
            vertexData[vo++] = x; vertexData[vo++] = y; vertexData[vo++] = z;
            vertexData[vo++] = i / SEG; vertexData[vo++] = j / RING;
        }
    }
    const indexData = new Uint16Array(SEG * RING * 6);
    let io = 0;
    for (let j = 0; j < RING; j++) {
        for (let i = 0; i < SEG; i++) {
            const a = j * (SEG + 1) + i, b = a + SEG + 1;
            indexData[io++] = a; indexData[io++] = a + 1; indexData[io++] = b;
            indexData[io++] = a + 1; indexData[io++] = b + 1; indexData[io++] = b;
        }
    }

    const model: BIN.BINModel = {
        bbox: new AABB(-1, -1, -1, 1, 1, 1),
        vertexData, indexData,
        modelParts: [{
            diffuseColor: colorNewFromRGBA(1, 1, 1, 1),
            indexOffset: 0, indexCount: indexData.length,
            textureIndex: 0, gsConfiguration, lit: true,
        }],
        animationIndex: 0,
    };
    const texture: BIN.BINTexture = { tex0_data0: 0, tex0_data1: 0, pixels: [pixels, pixels], name: 'ball', width: W, height: H };
    return { models: [model], textures: [texture] };
}

const scratchV = vec3.create();
const scratchV2 = vec3.create();
const scratchM = mat4.create();
const scratchM2 = mat4.create();
const scratchQ = quat.create();
const identity = mat4.create();

export class KatamariGame implements CameraController {
    public camera: Camera;
    public forceUpdate = false;

    public pos = vec3.create();
    public vel = vec3.create();
    public rot = quat.create();
    public radius = START_DIAMETER / 2;
    public volume = 4 / 3 * Math.PI * Math.pow(START_DIAMETER / 2, 3);
    public grounded = false;
    public yaw = 0;
    public pitch = 0.32;
    public collectedCount = 0;
    public areaIndex = 0;
    public onhud: ((game: KatamariGame) => void) | null = null;
    public lastPickupTime = -1e9;

    private meshes: CollisionMesh[] = [];
    private mesh: CollisionMesh;
    private objects: GameObject[] = [];
    private stuckList: GameObject[] = [];
    private near: GameObject[] = [];
    private ballMatrix = mat4.create();
    private ballInstance: BINModelInstance;
    private ballSectorData: BINModelSectorData;
    private spawn = vec3.create();
    private camPos = vec3.create();
    private camTarget = vec3.create();
    private camInit = false;
    private time = 0;
    // Recent known-good resting places for the ball, oldest first.
    private safeHistory: vec3[] = [];
    private lastSafeTime = 0;
    private lostTime = 0;
    private groundNormal = vec3.fromValues(0, 1, 0);
    private looseList: GameObject[] = [];
    private hitCooldownUntil = 0;
    public lastHitTime = -1e9;

    // Build mode: place extra copies of the level's own objects.
    public buildMode = false;
    public buildText = '';
    private buildTypes: { modelIndex: number, id: number, size: number }[] = [];
    private buildIndex = 0;
    private preview: GameObject | null = null;
    private placedList: { obj: GameObject, entry: MapAddition }[] = [];
    private additionsLoaded = false;
    private spin = vec3.create();

    constructor(device: GfxDevice, private renderer: KatamariDamacyRenderer) {
        // Level collision: sector 0 is the main world mesh.
        for (let i = 0; i < renderer.areaCollision.length; i++)
            this.meshes.push(new CollisionMesh(renderer.areaCollision[i][0]));
        this.mesh = this.meshes[0];

        const byRenderer = new Map<ObjectRenderer, GameObject>();
        for (let i = 0; i < renderer.objectRenderers.length; i++) {
            const obj = this.makeGameObject(renderer.objectRenderers[i]);
            this.objects.push(obj);
            byRenderer.set(obj.renderer, obj);
        }
        for (const obj of this.objects) {
            const ps = obj.renderer.parentState;
            if (ps !== null && byRenderer.has(ps.parent))
                byRenderer.get(ps.parent)!.children.push(obj);
        }

        // The ball itself, drawn through the same pipeline as the level objects.
        let gsConfiguration: BIN.GSConfiguration | null = null;
        outer:
        for (const m of renderer.missionSetupBin.objectModels) {
            for (const model of m.sector.models) {
                for (const part of model.modelParts) {
                    if (part.lit && part.textureIndex !== null) {
                        gsConfiguration = part.gsConfiguration;
                        break outer;
                    }
                }
            }
        }
        const cache = renderer.renderHelper.renderCache;
        this.ballSectorData = new BINModelSectorData(device, cache, makeBallSector(gsConfiguration!));
        renderer.modelSectorData.push(this.ballSectorData);
        this.ballInstance = new BINModelInstance(device, cache, this.ballSectorData.modelData[0]);
        this.ballInstance.layer = GfxRendererLayer.TRANSLUCENT + KDLayer.OBJECTS;

        renderer.setCurrentAreaNo(renderer.missionSetupBin.activeStageAreas[0]);
        this.chooseSpawn();
        this.respawn();
        renderer.game = this;
        this.initBuildTypes();
    }

    private makeGameObject(r: ObjectRenderer): GameObject {
        const bb = r.bbox;
        const dx = Math.max(bb.max[0] - bb.min[0], 0), dy = Math.max(bb.max[1] - bb.min[1], 0), dz = Math.max(bb.max[2] - bb.min[2], 0);
        const volume = dx * dy * dz;
        const def = this.renderer.missionSetupBin.objectDefs[r.objectSpawn.modelIndex];
        const solid = !def.dummyParent && isFinite(volume) && volume > 0;
        return {
            renderer: r, index: this.objects.length, volume: solid ? volume : 0, size: Math.cbrt(volume),
            boundRadius: 0.5 * Math.hypot(dx, dy, dz), solid, children: [], stuck: false, local: null, attachRadius: 1,
            loose: null, noCollectUntil: 0, lastCenter: null, lastCenterTime: 0, moveSpeed: 0, placed: false,
        };
    }

    private objectCenter(dst: vec3, obj: GameObject): void {
        obj.renderer.bbox.centerPoint(dst);
        vec3.transformMat4(dst, dst, obj.renderer.modelMatrix);
        dst[1] = -dst[1]; dst[2] = -dst[2];
    }

    private chooseSpawn(): void {
        // Start where the small stuff is: the densest cluster of things a 1m ball can roll up.
        const CELL = 600;
        const cells = new Map<string, { n: number, x: number, z: number }>();
        const c = vec3.create();
        for (const obj of this.objects) {
            if (!obj.solid || !obj.renderer.visible || obj.size > PICKUP_RATIO * START_DIAMETER)
                continue;
            this.objectCenter(c, obj);
            const key = `${Math.floor(c[0] / CELL)},${Math.floor(c[2] / CELL)}`;
            const cell = cells.get(key) ?? { n: 0, x: 0, z: 0 };
            cell.n++; cell.x += c[0]; cell.z += c[2];
            cells.set(key, cell);
        }
        const sorted = [...cells.values()].sort((a, b) => b.n - a.n);
        const r = START_DIAMETER / 2;
        for (const cell of sorted) {
            const cx = cell.x / cell.n, cz = cell.z / cell.n;
            // Look for an open patch of ground near the cluster.
            for (let ring = 0; ring < 6; ring++) {
                for (let k = 0; k < 8; k++) {
                    const a = k / 8 * Math.PI * 2;
                    const x = cx + Math.cos(a) * ring * 120, z = cz + Math.sin(a) * ring * 120;
                    const y = this.mesh.groundHeight(x, z, Infinity);
                    if (!isFinite(y))
                        continue;
                    vec3.set(this.spawn, x, y + r + 2, z);
                    if (this.isClear(this.spawn, r)) {
                        this.yaw = Math.atan2(cx - x, cz - z);
                        return;
                    }
                    if (ring === 0)
                        break;
                }
            }
        }
        // Fallback: middle of the mesh.
        vec3.set(this.spawn, 0, this.mesh.maxY + r, 0);
    }

    // Closest point on an object's oriented bounding box to p (noclip space). Returns true if p is inside the box.
    private closestOnObject(out: vec3, obj: GameObject, p: vec3): boolean {
        const bb = obj.renderer.bbox;
        mat4.mul(scratchM, toNoclip, obj.renderer.modelMatrix);
        if (mat4.invert(scratchM2, scratchM) === null) {
            vec3.set(out, Infinity, Infinity, Infinity);
            return false;
        }
        vec3.transformMat4(out, p, scratchM2);
        const inside = out[0] > bb.min[0] && out[0] < bb.max[0] && out[1] > bb.min[1] && out[1] < bb.max[1] && out[2] > bb.min[2] && out[2] < bb.max[2];
        out[0] = Math.min(bb.max[0], Math.max(bb.min[0], out[0]));
        out[1] = Math.min(bb.max[1], Math.max(bb.min[1], out[1]));
        out[2] = Math.min(bb.max[2], Math.max(bb.min[2], out[2]));
        vec3.transformMat4(out, out, scratchM);
        return inside;
    }

    private isClear(p: vec3, r: number): boolean {
        const c = vec3.create();
        for (const obj of this.objects) {
            if (!obj.solid || !obj.renderer.visible || obj.size <= PICKUP_RATIO * 2 * r)
                continue;
            if (this.closestOnObject(c, obj, p) || vec3.dist(c, p) < r * 1.5)
                return false;
        }
        return true;
    }

    private isLost(): boolean {
        if (!isFinite(this.pos[0] + this.pos[1] + this.pos[2]) || !isFinite(this.vel[0] + this.vel[1] + this.vel[2]))
            return true;
        // Nothing underneath at all: we have slipped through the world or rolled off its edge.
        return !this.grounded && !isFinite(this.mesh.groundHeight(this.pos[0], this.pos[2], this.pos[1] + this.radius));
    }

    private trackSafety(dt: number): void {
        if (this.isLost()) {
            this.lostTime += dt;
            if (this.lostTime > 0.6 || !isFinite(this.pos[0] + this.pos[1] + this.pos[2]))
                this.restore();
            return;
        }
        this.lostTime = 0;
        if (this.grounded && this.time - this.lastSafeTime > 0.5) {
            this.lastSafeTime = this.time;
            this.safeHistory.push(vec3.clone(this.pos));
            if (this.safeHistory.length > 20)
                this.safeHistory.shift();
        }
    }

    // Put the ball (and everything stuck to it) back where it last sat safely on the ground.
    // Pressing it again steps further back in time.
    public restore(): void {
        // Skip the most recent second or so, in case it was already going wrong.
        if (this.safeHistory.length > 3)
            this.safeHistory.length -= 2;
        const p = this.safeHistory.pop();
        if (p === undefined) {
            this.respawn();
        } else {
            vec3.copy(this.pos, p);
            // The ball may have grown since; sit it on the ground at its current size.
            const y = this.mesh.groundHeight(p[0], p[2], p[1] + this.radius);
            if (isFinite(y) && this.pos[1] < y + this.radius)
                this.pos[1] = y + this.radius;
            this.pos[1] += 2;
        }
        vec3.zero(this.vel);
        vec3.zero(this.spin);
        if (!isFinite(this.rot[0] + this.rot[1] + this.rot[2] + this.rot[3]))
            quat.identity(this.rot);
        this.lostTime = 0;
        this.lastSafeTime = this.time;
        this.camInit = false;
    }

    public respawn(): void {
        vec3.copy(this.pos, this.spawn);
        const y = this.mesh.groundHeight(this.pos[0], this.pos[2], Infinity);
        if (isFinite(y))
            this.pos[1] = y + this.radius + 2;
        vec3.zero(this.vel);
    }

    public get diameter(): number { return this.radius * 2; }

    // CameraController
    public cameraUpdateForced(): void {}
    public setSceneMoveSpeedMult(v: number): void {}
    public getKeyMoveSpeed(): number | null { return null; }
    public setKeyMoveSpeed(speed: number): void {}

    public update(inputManager: InputManager, dtMs: number, sceneTimeScale: number): CameraUpdateResult {
        const dt = Math.min(dtMs / 1000, 0.05);
        this.time += dt;
        if (dt > 0)
            this.step(inputManager, dt);
        this.updateCamera(dt);
        if (this.onhud !== null)
            this.onhud(this);
        return CameraUpdateResult.Changed;
    }

    private step(input: InputManager, dt: number): void {
        const r = this.radius;

        // Steering: A/D (or left/right) turn, W/S (or up/down) push. Dragging the mouse also looks around.
        let turn = 0, push = 0;
        if (input.isKeyDown('KeyA') || input.isKeyDown('ArrowLeft')) turn += 1;
        if (input.isKeyDown('KeyD') || input.isKeyDown('ArrowRight')) turn -= 1;
        if (input.isKeyDown('KeyW') || input.isKeyDown('ArrowUp')) push += 1;
        if (input.isKeyDown('KeyS') || input.isKeyDown('ArrowDown')) push -= 1;
        const boost = input.isKeyDown('ShiftLeft') || input.isKeyDown('ShiftRight') || input.isKeyDown('Space');
        this.yaw += turn * 2.0 * dt;
        if (input.isDragging()) {
            this.yaw -= input.getMouseDeltaX() * 0.005;
            this.pitch = Math.min(1.2, Math.max(-0.1, this.pitch + input.getMouseDeltaY() * 0.004));
        }
        if (input.isKeyDownEventTriggered('KeyR'))
            this.restore();
        if (input.isKeyDownEventTriggered('Home'))
            this.respawn();

        const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
        const maxSpeed = r * (boost ? 6.5 : 4.4);
        const gravity = Math.max(r * 28, 900);

        const speed = Math.hypot(this.vel[0], this.vel[2]);
        const sub = Math.max(1, Math.min(8, Math.ceil((speed + Math.abs(this.vel[1])) * dt / (r * 0.35))));
        const h = dt / sub;

        this.gatherNearObjects(speed * dt + r);

        for (let s = 0; s < sub; s++) {
            const n = this.groundNormal;
            if (push !== 0) {
                // Push along the surface we're on, not flat into the hillside.
                let tx = fx * push, ty = 0, tz = fz * push;
                if (this.grounded) {
                    const d = tx * n[0] + tz * n[2];
                    tx -= n[0] * d; ty -= n[1] * d; tz -= n[2] * d;
                    const len = Math.hypot(tx, ty, tz);
                    if (len > 1e-4) { tx /= len; ty /= len; tz /= len; } else { tx = fx * push; ty = 0; tz = fz * push; }
                }
                const accel = r * (this.grounded ? 11 : 2.5) * (boost ? 1.6 : 1);
                // Only add speed along the push direction up to the cap.
                const along = this.vel[0] * tx + this.vel[1] * ty + this.vel[2] * tz;
                if (along < maxSpeed) {
                    const add = Math.min(accel * h, maxSpeed - along);
                    this.vel[0] += tx * add; this.vel[1] += ty * add; this.vel[2] += tz * add;
                }
                // Climbing: while you're pushing uphill, most of the pull back down the slope is cancelled,
                // fading out as the slope gets close to a wall.
                if (this.grounded && ty > 0) {
                    const assist = 0.9 * Math.min(1, Math.max(0, (n[1] - 0.42) / 0.2));
                    const gs = gravity * h * assist;
                    this.vel[0] -= n[0] * n[1] * gs;
                    this.vel[1] -= (n[1] * n[1] - 1) * gs;
                    this.vel[2] -= n[2] * n[1] * gs;
                }
            }
            if (this.grounded) {
                // Rolling resistance; stronger sideways so the ball goes where you point it, light along the
                // direction of travel so it keeps its momentum.
                const along = this.vel[0] * fx + this.vel[2] * fz;
                const sideX = this.vel[0] - fx * along, sideZ = this.vel[2] - fz * along;
                const kAlong = Math.exp(-(push !== 0 ? 0.15 : 1.3) * h), kSide = Math.exp(-3.0 * h);
                this.vel[0] = fx * along * kAlong + sideX * kSide;
                this.vel[2] = fz * along * kAlong + sideZ * kSide;
            }
            this.vel[1] -= gravity * h;
            vec3.scaleAndAdd(this.pos, this.pos, this.vel, h);

            this.grounded = false;
            this.collideLevel();
            this.collideObjects();
        }

        this.trackSafety(dt);

        // Roll.
        if (this.grounded) {
            vec3.cross(this.spin, this.groundNormal, this.vel);
            vec3.scale(this.spin, this.spin, 1 / this.radius);
        } else {
            vec3.scale(this.spin, this.spin, Math.exp(-0.5 * dt));
        }
        const w = vec3.length(this.spin);
        if (w > 1e-5) {
            vec3.scale(scratchV, this.spin, 1 / w);
            quat.setAxisAngle(scratchQ, scratchV, w * dt);
            quat.mul(this.rot, scratchQ, this.rot);
            quat.normalize(this.rot, this.rot);
        }

        this.updateArea();
        this.updateStuck();
        this.updateLoose(dt);
        this.updateBuild(input);
    }

    private resolveContact(cx: number, cy: number, cz: number, fallbackN: vec3 | null): boolean {
        const r = this.radius;
        let dx = this.pos[0] - cx, dy = this.pos[1] - cy, dz = this.pos[2] - cz;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (!(d2 < r * r)) // also rejects NaN
            return false;
        let d = Math.sqrt(d2);
        if (d < 1e-4) {
            if (fallbackN === null)
                return false;
            dx = fallbackN[0]; dy = fallbackN[1]; dz = fallbackN[2]; d = 0;
        } else {
            dx /= d; dy /= d; dz /= d;
        }
        const pen = r - d;
        this.pos[0] += dx * pen; this.pos[1] += dy * pen; this.pos[2] += dz * pen;
        const vn = this.vel[0] * dx + this.vel[1] * dy + this.vel[2] * dz;
        if (vn < 0) {
            const before = Math.hypot(this.vel[0], this.vel[2]);
            // A little bounce off walls, none off the floor or off anything we can roll up and over.
            const e = dy > 0.12 ? 0 : 0.25;
            this.vel[0] -= (1 + e) * vn * dx; this.vel[1] -= (1 + e) * vn * dy; this.vel[2] -= (1 + e) * vn * dz;
            if (dy > 0.12 && dy < 0.85) {
                // Kerbs, steps and ramps: roll up over the edge instead of stopping dead against it.
                const after = Math.hypot(this.vel[0], this.vel[1], this.vel[2]);
                const keep = before * (0.55 + 0.4 * dy);
                if (after > 1e-3 && after < keep)
                    vec3.scale(this.vel, this.vel, keep / after);
            }
        }
        if (dy > 0.42) {
            this.grounded = true;
            vec3.set(this.groundNormal, dx, dy, dz);
        }
        return true;
    }

    private collideLevel(): void {
        const mesh = this.mesh;
        const r = this.radius;
        const t = mesh.tris;
        for (let iter = 0; iter < 3; iter++) {
            const n = mesh.query(this.pos[0] - r, this.pos[2] - r, this.pos[0] + r, this.pos[2] + r);
            let any = false;
            for (let i = 0; i < n; i++) {
                const o = mesh.result[i] * 9;
                closestPointOnTriangle(cp, this.pos[0], this.pos[1], this.pos[2], t, o);
                if (this.resolveContact(cp[0], cp[1], cp[2], null))
                    any = true;
            }
            if (!any)
                break;
        }
    }

    private gatherNearObjects(margin: number): void {
        this.near.length = 0;
        const r = this.radius;
        for (let i = 0; i < this.objects.length; i++) {
            const obj = this.objects[i];
            if (obj.stuck || !obj.solid || !obj.renderer.visible)
                continue;
            const m = obj.renderer.modelMatrix;
            if (!isFinite(m[12] + m[13] + m[14]))
                continue;
            // Cheap reject using the object's origin before doing the real centre.
            const reach = r + obj.boundRadius * 2 + margin;
            if (Math.abs(m[12] - this.pos[0]) > reach || Math.abs(-m[14] - this.pos[2]) > reach)
                continue;
            this.objectCenter(scratchV, obj);
            if (vec3.dist(scratchV, this.pos) < r + obj.boundRadius + margin + r * 3) {
                // Track how fast self-moving things are going.
                if (obj.renderer.motionState !== null && obj.loose === null) {
                    if (obj.lastCenter !== null && this.time - obj.lastCenterTime < 0.5 && this.time > obj.lastCenterTime)
                        obj.moveSpeed = obj.moveSpeed * 0.7 + 0.3 * vec3.dist(scratchV, obj.lastCenter) / (this.time - obj.lastCenterTime);
                    else
                        obj.moveSpeed = 0;
                    if (obj.lastCenter === null)
                        obj.lastCenter = vec3.create();
                    vec3.copy(obj.lastCenter, scratchV);
                    obj.lastCenterTime = this.time;
                }
            }
            if (vec3.dist(scratchV, this.pos) < r + obj.boundRadius + margin)
                this.near.push(obj);
        }
    }

    private collideObjects(): void {
        for (let i = 0; i < this.near.length; i++) {
            const obj = this.near[i];
            if (obj.stuck || this.time < obj.noCollectUntil)
                continue;
            const inside = this.closestOnObject(scratchV, obj, this.pos);
            const canCollect = obj.size <= PICKUP_RATIO * this.diameter;
            // Be a little generous about what counts as touching something we can roll up.
            const reach = this.radius * (canCollect ? 1.1 : 1.0);
            const touching = inside || vec3.sqrDist(scratchV, this.pos) < reach * reach;
            if (!touching)
                continue;

            if (canCollect) {
                this.collect(obj);
                continue;
            }
            // Something bigger than us that is moving under its own power: it knocks things off the ball.
            if (obj.moveSpeed > 8 && this.time >= this.hitCooldownUntil) {
                this.objectCenter(scratchV2, obj);
                this.gotHit(scratchV2);
            }
            if (inside) {
                // Deep inside something too big to pick up: push out away from its centre.
                this.objectCenter(scratchV2, obj);
                vec3.sub(scratchV2, this.pos, scratchV2);
                scratchV2[1] = Math.max(scratchV2[1], 0);
                if (vec3.length(scratchV2) < 1e-3)
                    vec3.set(scratchV2, 0, 1, 0);
                vec3.normalize(scratchV2, scratchV2);
                vec3.scaleAndAdd(this.pos, this.pos, scratchV2, this.radius * 0.25);
            } else {
                this.resolveContact(scratchV[0], scratchV[1], scratchV[2], null);
            }
        }
    }

    private computeBallMatrix(): void {
        mat4.fromRotationTranslation(this.ballMatrix, this.rot, this.pos);
    }

    private stick(obj: GameObject, offset: vec3 | null): void {
        // Transform relative to the ball, in noclip space.
        mat4.mul(scratchM, toNoclip, obj.renderer.modelMatrix);
        if (offset !== null) {
            scratchM[12] += offset[0]; scratchM[13] += offset[1]; scratchM[14] += offset[2];
        }
        mat4.invert(scratchM2, this.ballMatrix);
        obj.local = mat4.create();
        mat4.mul(obj.local, scratchM2, scratchM);
        obj.attachRadius = this.radius;
        obj.stuck = true;
        if (obj.loose !== null) {
            obj.loose = null;
            const li = this.looseList.indexOf(obj);
            if (li >= 0)
                this.looseList.splice(li, 1);
        }
        obj.renderer.stuckMatrix = mat4.create();
        obj.renderer.useAltObject = false;
        this.stuckList.push(obj);
        this.collectedCount++;
        this.volume += GROWTH * obj.volume;
    }

    private collect(obj: GameObject): void {
        this.computeBallMatrix();

        // Pull the object in so it sits on the surface of the core ball.
        this.objectCenter(scratchV, obj);
        vec3.sub(scratchV2, scratchV, this.pos);
        let d = vec3.length(scratchV2);
        if (d < 1e-3) { vec3.set(scratchV2, 0, 1, 0); d = 1; }
        vec3.scale(scratchV2, scratchV2, 1 / d);
        const want = this.radius * CORE_RATIO + 0.3 * Math.min(obj.size, this.radius);
        const offset = vec3.create();
        vec3.scale(offset, scratchV2, want - d);

        // Something that has been knocked off is on its own now: whatever used to ride on it landed somewhere else.
        const bringRiders = obj.loose === null;
        this.stick(obj, offset);
        // Anything still riding on it comes along.
        const stack = bringRiders ? [...obj.children] : [];
        while (stack.length > 0) {
            const child = stack.pop()!;
            if (child.stuck || child.loose !== null || !child.renderer.visible)
                continue;
            stack.push(...child.children);
            this.stick(child, offset);
        }

        const newRadius = Math.cbrt(this.volume * 3 / (4 * Math.PI));
        this.pos[1] += newRadius - this.radius;
        this.radius = newRadius;
        this.lastPickupTime = this.time;
    }

    private updateStuck(): void {
        this.computeBallMatrix();
        const list = this.stuckList;
        const minSize = this.diameter * 0.035;
        const firstRecent = list.length - MAX_VISIBLE_STUCK;
        for (let i = 0; i < list.length; i++) {
            const obj = list[i];
            // Old, tiny things are buried in the clump; stop drawing them.
            const show = i >= firstRecent && (obj.size >= minSize || i >= list.length - 40);
            obj.renderer.visible = show;
            if (!show)
                continue;
            // Ride outward as the ball grows.
            const k = this.radius / obj.attachRadius;
            mat4.copy(scratchM, obj.local!);
            const grow = 1 + (k - 1) * 0.85;
            scratchM[12] *= grow; scratchM[13] *= grow; scratchM[14] *= grow;
            mat4.mul(scratchM, this.ballMatrix, scratchM);
            mat4.mul(obj.renderer.stuckMatrix!, toNoclip, scratchM);
        }
    }

    public onAreaChanged(): void {
        // The scene just reset visibility for the new area; stuck and loose objects are ours to manage.
        this.updateStuck();
        for (const obj of this.looseList)
            obj.renderer.visible = true;
    }

    // Katamari-space matrix for an object standing upright on the ground at (x, groundY, z) in noclip space.
    private uprightMatrix(dst: mat4, obj: GameObject, x: number, groundY: number, z: number, yaw: number): void {
        mat4.fromYRotation(dst, yaw);
        dst[12] = x;
        dst[13] = -groundY - obj.renderer.bbox.max[1];
        dst[14] = -z;
    }

    private gotHit(from: vec3): void {
        this.hitCooldownUntil = this.time + 1.2;
        this.lastHitTime = this.time;
        // Bounce away from whatever hit us.
        let dx = this.pos[0] - from[0], dz = this.pos[2] - from[2];
        const d = Math.hypot(dx, dz);
        if (d > 1e-3) { dx /= d; dz /= d; } else { dx = -Math.sin(this.yaw); dz = -Math.cos(this.yaw); }
        const r = this.radius;
        this.vel[0] = dx * r * 3.5; this.vel[2] = dz * r * 3.5; this.vel[1] = r * 2.5;

        const count = Math.min(this.stuckList.length, Math.max(1, Math.min(12, Math.round(this.stuckList.length * 0.12))));
        this.knockOff(count);
    }

    // Throw the most recently collected things off the ball. They land nearby and can be rolled up again.
    public knockOff(count: number): void {
        this.computeBallMatrix();
        const r = this.radius;
        for (let i = 0; i < count && this.stuckList.length > 0; i++) {
            const obj = this.stuckList.pop()!;
            // Where it is right now, in noclip space.
            const k = r / obj.attachRadius;
            mat4.copy(scratchM, obj.local!);
            const grow = 1 + (k - 1) * 0.85;
            scratchM[12] *= grow; scratchM[13] *= grow; scratchM[14] *= grow;
            mat4.mul(scratchM, this.ballMatrix, scratchM);

            const pos = vec3.fromValues(scratchM[12], scratchM[13], scratchM[14]);
            const rot = mat4.clone(scratchM);
            rot[12] = 0; rot[13] = 0; rot[14] = 0;
            const vel = vec3.create();
            vec3.sub(vel, pos, this.pos);
            vel[1] = 0;
            if (vec3.length(vel) < 1e-3)
                vec3.set(vel, Math.random() - 0.5, 0, Math.random() - 0.5);
            vec3.normalize(vel, vel);
            const a = Math.random() * Math.PI * 2;
            vel[0] += Math.cos(a) * 0.6; vel[2] += Math.sin(a) * 0.6;
            vec3.scale(vel, vel, r * (2.0 + Math.random() * 2.0));
            vel[1] = r * (3.5 + Math.random() * 2.5);
            const axis = vec3.fromValues(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5);
            vec3.normalize(axis, axis);

            obj.stuck = false;
            obj.local = null;
            obj.loose = { pos, vel, rot, axis, spinRate: 4 + Math.random() * 6, resting: false };
            obj.noCollectUntil = this.time + 2.0;
            obj.renderer.visible = true;
            this.looseList.push(obj);
            this.collectedCount--;
            this.volume -= GROWTH * obj.volume;
        }
        const minVolume = 4 / 3 * Math.PI * Math.pow(START_DIAMETER / 2, 3);
        this.volume = Math.max(this.volume, minVolume);
        this.radius = Math.cbrt(this.volume * 3 / (4 * Math.PI));
    }

    private updateLoose(dt: number): void {
        const gravity = Math.max(this.radius * 28, 900);
        for (const obj of this.looseList) {
            const l = obj.loose!;
            if (l.resting)
                continue;
            l.vel[1] -= gravity * dt;
            vec3.scaleAndAdd(l.pos, l.pos, l.vel, dt);
            mat4.fromRotation(scratchM2, l.spinRate * dt, l.axis);
            mat4.mul(l.rot, scratchM2, l.rot);

            let ground = this.mesh.groundHeight(l.pos[0], l.pos[2], l.pos[1] + obj.boundRadius * 2 + 50);
            if (!isFinite(ground))
                ground = this.pos[1] - this.radius;
            if (l.vel[1] < 0 && l.pos[1] - obj.boundRadius * 0.5 <= ground) {
                // Landed: stand it back up on the ground.
                l.resting = true;
                this.uprightMatrix(obj.renderer.stuckMatrix!, obj, l.pos[0], ground, l.pos[2], Math.random() * Math.PI * 2);
            } else {
                mat4.copy(scratchM, l.rot);
                scratchM[12] = l.pos[0]; scratchM[13] = l.pos[1]; scratchM[14] = l.pos[2];
                mat4.mul(obj.renderer.stuckMatrix!, toNoclip, scratchM);
            }
        }
    }

    // ---- Build mode -------------------------------------------------------------------------------------------

    private initBuildTypes(): void {
        const ms = this.renderer.missionSetupBin;
        const seen = new Set<number>();
        for (const obj of this.objects) {
            const mi = obj.renderer.objectSpawn.modelIndex;
            if (seen.has(mi) || !obj.solid || !isFinite(obj.size))
                continue;
            seen.add(mi);
            this.buildTypes.push({ modelIndex: mi, id: ms.objectModels[mi].id, size: obj.size });
        }
        this.buildTypes.sort((a, b) => a.size - b.size);
    }

    private spawnAt(modelIndex: number, x: number, groundY: number, z: number, yaw: number): GameObject | null {
        if (this.renderer.spawnExtra === null)
            return null;
        const r = this.renderer.spawnExtra(modelIndex, identity);
        if (r === null)
            return null;
        const obj = this.makeGameObject(r);
        r.stuckMatrix = mat4.create();
        this.uprightMatrix(r.stuckMatrix, obj, x, groundY, z, yaw);
        mat4.copy(r.modelMatrix, r.stuckMatrix);
        obj.placed = true;
        return obj;
    }

    private removeRenderer(obj: GameObject): void {
        const list = this.renderer.objectRenderers;
        const i = list.indexOf(obj.renderer);
        if (i >= 0)
            list.splice(i, 1);
    }

    // Add one object to the map. Returns false if this level doesn't have that object type.
    public addToMap(entry: MapAddition): boolean {
        const type = this.buildTypes.find((t) => t.id === entry.id);
        if (type === undefined)
            return false;
        let ground = this.meshes[0].groundHeight(entry.x, entry.z, entry.y + 60);
        if (!isFinite(ground))
            ground = entry.y;
        const obj = this.spawnAt(type.modelIndex, entry.x, ground, entry.z, entry.yaw ?? 0);
        if (obj === null)
            return false;
        obj.loose = { pos: vec3.create(), vel: vec3.create(), rot: mat4.create(), axis: vec3.fromValues(0, 1, 0), spinRate: 0, resting: true };
        this.looseList.push(obj);
        this.objects.push(obj);
        this.placedList.push({ obj, entry });
        return true;
    }

    private saveAdditions(): void {
        try {
            window.localStorage.setItem('katamari-map-additions', JSON.stringify(this.placedList.filter((p) => (p.entry as any).fromFile !== true).map((p) => p.entry)));
        } catch (e) {
        }
    }

    // Everything added by hand: the MAP_ADDITIONS list in the HTML file, plus what was placed in build mode.
    public loadAdditions(fromFile: MapAddition[]): void {
        if (this.additionsLoaded)
            return;
        this.additionsLoaded = true;
        for (const e of fromFile) {
            if (e && isFinite(e.id) && isFinite(e.x) && isFinite(e.y) && isFinite(e.z))
                this.addToMap({ ...e, fromFile: true } as any);
        }
        try {
            const saved = JSON.parse(window.localStorage.getItem('katamari-map-additions') ?? '[]');
            for (const e of saved)
                if (e && isFinite(e.id) && isFinite(e.x) && isFinite(e.y) && isFinite(e.z))
                    this.addToMap(e);
        } catch (e) {
        }
    }

    public additionsAsText(): string {
        const f = (v: number) => Math.round(v);
        return 'window.MAP_ADDITIONS = [\n' + this.placedList.map((p) =>
            `  { id: ${p.entry.id}, x: ${f(p.entry.x)}, y: ${f(p.entry.y)}, z: ${f(p.entry.z)}, yaw: ${(p.entry.yaw ?? 0).toFixed(2)} },`).join('\n') + '\n];';
    }

    private setPreview(index: number): void {
        if (this.preview !== null) {
            this.removeRenderer(this.preview);
            this.preview = null;
        }
        const n = this.buildTypes.length;
        if (n === 0)
            return;
        this.buildIndex = ((index % n) + n) % n;
        this.preview = this.spawnAt(this.buildTypes[this.buildIndex].modelIndex, this.pos[0], this.pos[1], this.pos[2], 0);
    }

    private previewSpot(out: vec3): void {
        const p = this.preview!;
        const ahead = this.radius * 1.8 + p.boundRadius + 20;
        out[0] = this.pos[0] + Math.sin(this.yaw) * ahead;
        out[2] = this.pos[2] + Math.cos(this.yaw) * ahead;
        let ground = this.mesh.groundHeight(out[0], out[2], this.pos[1] + this.radius);
        if (!isFinite(ground))
            ground = this.pos[1] - this.radius;
        out[1] = ground;
    }

    private updateBuild(input: InputManager): void {
        if (input.isKeyDownEventTriggered('KeyB')) {
            this.buildMode = !this.buildMode;
            if (this.buildMode) {
                // Start with something about a third of the ball's size.
                let best = 0;
                for (let i = 0; i < this.buildTypes.length; i++)
                    if (Math.abs(this.buildTypes[i].size - this.diameter * 0.3) < Math.abs(this.buildTypes[best].size - this.diameter * 0.3))
                        best = i;
                this.setPreview(this.preview === null ? best : this.buildIndex);
            } else if (this.preview !== null) {
                this.removeRenderer(this.preview);
                this.preview = null;
            }
        }
        if (!this.buildMode || this.preview === null) {
            this.buildText = '';
            return;
        }

        const stepBy = (input.isKeyDown('ShiftLeft') || input.isKeyDown('ShiftRight')) ? 10 : 1;
        if (input.isKeyDownEventTriggered('KeyE'))
            this.setPreview(this.buildIndex + stepBy);
        if (input.isKeyDownEventTriggered('KeyQ'))
            this.setPreview(this.buildIndex - stepBy);
        if (this.preview === null)
            return;

        const yaw = this.yaw + Math.PI;
        this.previewSpot(scratchV);
        this.uprightMatrix(this.preview.renderer.stuckMatrix!, this.preview, scratchV[0], scratchV[1], scratchV[2], yaw);
        this.preview.renderer.visible = true;

        const type = this.buildTypes[this.buildIndex];
        if (input.isKeyDownEventTriggered('KeyF') || input.isKeyDownEventTriggered('Enter')) {
            if (this.addToMap({ id: type.id, x: scratchV[0], y: scratchV[1], z: scratchV[2], yaw }))
                this.saveAdditions();
        }
        if (input.isKeyDownEventTriggered('KeyZ')) {
            // Undo the most recent placement that hasn't been rolled up.
            for (let i = this.placedList.length - 1; i >= 0; i--) {
                const p = this.placedList[i];
                if (p.obj.stuck)
                    continue;
                this.placedList.splice(i, 1);
                this.removeRenderer(p.obj);
                p.obj.solid = false;
                p.obj.renderer.visible = false;
                const li = this.looseList.indexOf(p.obj);
                if (li >= 0)
                    this.looseList.splice(li, 1);
                const oi = this.objects.indexOf(p.obj);
                if (oi >= 0)
                    this.objects.splice(oi, 1);
                break;
            }
            this.saveAdditions();
        }
        if (input.isKeyDownEventTriggered('KeyC')) {
            const text = this.additionsAsText();
            console.log(text);
            try { navigator.clipboard.writeText(text); } catch (e) {}
        }

        const cm = type.size >= 100 ? `${(type.size / 100).toFixed(1)}m` : `${Math.round(type.size)}cm`;
        this.buildText = `BUILD  ·  object ${this.buildIndex + 1} of ${this.buildTypes.length}  ·  id ${type.id}  ·  about ${cm}  ·  ${this.placedList.length} placed\n` +
            `Q / E change object (hold Shift to skip 10)  ·  F place  ·  Z undo  ·  C copy list  ·  B done`;
    }

    private updateArea(): void {
        let idx = 0;
        while (idx < AREA_THRESHOLDS.length && this.diameter >= AREA_THRESHOLDS[idx])
            idx++;
        idx = Math.min(idx, this.meshes.length - 1);
        if (idx <= this.areaIndex)
            return;
        this.areaIndex = idx;
        this.mesh = this.meshes[idx];
        this.renderer.setCurrentAreaNo(this.renderer.missionSetupBin.activeStageAreas[idx]);
        // The bigger area uses a coarser world; make sure we're on top of it.
        const y = this.mesh.groundHeight(this.pos[0], this.pos[2], this.pos[1] + this.radius * 6);
        if (isFinite(y) && this.pos[1] - this.radius < y)
            this.pos[1] = y + this.radius;
    }

    private updateCamera(dt: number): void {
        const r = this.radius;
        const dist = r * 5.2;
        const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
        // Look down over the ball while building, so what you're placing isn't hidden behind it.
        const pitch = this.buildMode ? Math.max(this.pitch, 0.75) : this.pitch;
        const cosP = Math.cos(pitch), sinP = Math.sin(pitch);
        const tx = this.pos[0], ty = this.pos[1] + r * 0.9, tz = this.pos[2];
        let px = tx - fx * dist * cosP, py = ty + dist * sinP, pz = tz - fz * dist * cosP;

        // Keep the camera out of the ground.
        const g = this.mesh.groundHeight(px, pz, py + r * 4);
        if (isFinite(g) && py < g + r * 0.5)
            py = g + r * 0.5;

        if (!this.camInit) {
            vec3.set(this.camPos, px, py, pz);
            vec3.set(this.camTarget, tx, ty, tz);
            this.camInit = true;
        } else {
            const k = 1 - Math.exp(-10 * dt);
            this.camPos[0] += (px - this.camPos[0]) * k;
            this.camPos[1] += (py - this.camPos[1]) * k;
            this.camPos[2] += (pz - this.camPos[2]) * k;
            const kt = 1 - Math.exp(-18 * dt);
            this.camTarget[0] += (tx - this.camTarget[0]) * kt;
            this.camTarget[1] += (ty - this.camTarget[1]) * kt;
            this.camTarget[2] += (tz - this.camTarget[2]) * kt;
        }

        mat4.targetTo(this.camera.worldMatrix, this.camPos, this.camTarget, [0, 1, 0]);
        this.camera.worldMatrixUpdated();
        this.camera.setClipPlanes(Math.max(r * 0.25, 2));
    }

    public prepareToRender(renderInstManager: GfxRenderInstManager, viewerInput: ViewerRenderInput): void {
        this.computeBallMatrix();
        const m = this.ballInstance.modelMatrix;
        mat4.copy(m, this.ballMatrix);
        const s = this.radius * CORE_RATIO;
        mat4.scale(m, m, [s, s, s]);
        const camM = viewerInput.camera.worldMatrix;
        const dist = Math.hypot(camM[12] - this.pos[0], camM[13] - this.pos[1], camM[14] - this.pos[2]);
        this.ballInstance.prepareToRender(renderInstManager, viewerInput, identity, 0, dist);
    }
}
