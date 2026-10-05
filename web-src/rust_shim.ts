// Plain-JS stand-in for the bits of noclip's Rust/WASM support library that the Katamari scene touches
// (just the frustum convex hull), so the game builds without a Rust toolchain. Ported from rust/src/geometry.rs.

export default async function init(): Promise<void> {}

export function glsl_compile(): string {
    throw new Error('WebGPU shader translation is not available in this build');
}

export class ConvexHull {
    private planes: number[] = []; // nx, ny, nz, d

    public free(): void {}

    public copy(): ConvexHull {
        const o = new ConvexHull();
        o.planes = this.planes.slice();
        return o;
    }

    public clear(): void {
        this.planes.length = 0;
    }

    public push_plane(x: number, y: number, z: number, d: number): void {
        const len = Math.hypot(x, y, z);
        if (!(len > 0))
            return; // degenerate (e.g. far plane of an infinite projection): never rejects anything
        this.planes.push(x / len, y / len, z / len, d / len);
    }

    public js_intersect_aabb(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): number {
        const p = this.planes;
        let result = 0; // Inside
        for (let i = 0; i < p.length; i += 4) {
            const nx = p[i], ny = p[i + 1], nz = p[i + 2], d = p[i + 3];
            if (nx * (nx >= 0 ? maxX : minX) + ny * (ny >= 0 ? maxY : minY) + nz * (nz >= 0 ? maxZ : minZ) + d < 0)
                return 1; // Outside
            if (nx * (nx >= 0 ? minX : maxX) + ny * (ny >= 0 ? minY : maxY) + nz * (nz >= 0 ? minZ : maxZ) + d < 0)
                result = 2; // Intersection
        }
        return result;
    }

    public js_contains_aabb(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): boolean {
        const p = this.planes;
        for (let i = 0; i < p.length; i += 4) {
            const nx = p[i], ny = p[i + 1], nz = p[i + 2], d = p[i + 3];
            if (nx * (nx >= 0 ? maxX : minX) + ny * (ny >= 0 ? maxY : minY) + nz * (nz >= 0 ? maxZ : minZ) + d < 0)
                return false;
        }
        return true;
    }

    public js_contains_point(v: ArrayLike<number>): boolean {
        const p = this.planes;
        for (let i = 0; i < p.length; i += 4)
            if (p[i] * v[0] + p[i + 1] * v[1] + p[i + 2] * v[2] + p[i + 3] < 0)
                return false;
        return true;
    }

    public js_intersect_sphere(x: number, y: number, z: number, radius: number): number {
        const p = this.planes;
        let result = 0;
        for (let i = 0; i < p.length; i += 4) {
            const dist = p[i] * x + p[i + 1] * y + p[i + 2] * z + p[i + 3];
            if (dist < -radius)
                return 1;
            else if (dist < radius)
                result = 2;
        }
        return result;
    }

    public js_contains_sphere(x: number, y: number, z: number, radius: number): boolean {
        return this.js_intersect_sphere(x, y, z, radius) !== 1;
    }

    public js_transform(m: ArrayLike<number>): void {
        throw new Error('ConvexHull.js_transform is not implemented in this build');
    }

    public debug_str(): string {
        return JSON.stringify(this.planes);
    }
}
