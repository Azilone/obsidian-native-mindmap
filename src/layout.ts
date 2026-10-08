export interface Size {
	w: number;
	h: number;
}

export type Side = 'left' | 'right' | 'top' | 'bottom';

/** x = left edge, y = vertical center (world coordinates). */
export interface Placed {
	x: number;
	y: number;
	w: number;
	h: number;
	depth: number;
	/** Which side of the central topic the branch grows on. */
	side: 1 | -1;
	branch: number;
	/** Sides the edge from the parent leaves / enters (absent on the root). */
	fromSide?: Side;
	toSide?: Side;
	/** Draw the incoming edge from this topic instead of the parent (timeline spine). */
	edgeFrom?: string;
}

export type LayoutMode = 'mindmap' | 'logic' | 'timeline';

export const LAYOUTS: { id: LayoutMode; name: string; icon: string }[] = [
	{ id: 'mindmap', name: 'Mindmap', icon: 'git-fork' },
	{ id: 'logic', name: 'Logic (to the right)', icon: 'list-tree' },
	{ id: 'timeline', name: 'Timeline', icon: 'git-commit-horizontal' },
];

export function normalizeLayout(v: unknown, fallback: LayoutMode = 'mindmap'): LayoutMode {
	if (v === 'balanced') return 'mindmap';
	if (v === 'right' || v === 'left') return 'logic';
	return v === 'mindmap' || v === 'logic' || v === 'timeline' ? v : fallback;
}

export interface TreeNode {
	id: string;
	children: TreeNode[];
}

export interface LayoutOptions {
	mode: LayoutMode;
	hGap: number;
	vGap: number;
	/** Children to lay out for a node (lets callers hide folded branches). */
	kids?: (n: TreeNode) => TreeNode[];
}

/**
 * Tree layout for the three modes. The central topic is centered on (0, 0).
 * - mindmap: first-level branches split left/right so both sides balance
 * - logic: everything grows to the right
 * - timeline: first-level topics are chained left→right along an axis; their
 *   details hang alternately above and below each event
 */
export function layoutTree<T extends TreeNode>(
	root: T,
	size: (id: string) => Size,
	opt: LayoutOptions,
): Map<string, Placed> {
	const out = new Map<string, Placed>();
	const heights = new Map<string, number>();
	const kids = (n: TreeNode) => (n === root ? n.children : opt.kids ? opt.kids(n) : n.children);
	const vGap = (depth: number) => (depth === 0 ? opt.vGap * 2 : depth === 1 ? opt.vGap * 1.3 : opt.vGap);
	const hGap = (depth: number) => (depth === 0 ? opt.hGap * 1.4 : opt.hGap);

	const measure = (n: TreeNode, depth: number): number => {
		let total = 0;
		kids(n).forEach((c, i) => {
			total += measure(c, depth + 1) + (i ? vGap(depth) : 0);
		});
		const h = Math.max(size(n.id).h, total);
		heights.set(n.id, h);
		return h;
	};
	const subtreeRight = (n: TreeNode): number => {
		const p = out.get(n.id);
		let r = p ? p.x + p.w : -Infinity;
		for (const c of kids(n)) r = Math.max(r, subtreeRight(c));
		return r;
	};
	const stackHeight = (list: TreeNode[], depth: number) =>
		list.reduce((acc, c, i) => acc + heights.get(c.id)! + (i ? vGap(depth) : 0), 0);

	const placeChildren = (
		target: Map<string, Placed>,
		list: TreeNode[],
		px: number,
		pw: number,
		cy: number,
		side: 1 | -1,
		depth: number,
		branchOf: (c: TreeNode) => number,
	) => {
		let y = cy - stackHeight(list, depth) / 2;
		for (const c of list) {
			const h = heights.get(c.id)!;
			const s = size(c.id);
			const x = side === 1 ? px + pw + hGap(depth) : px - hGap(depth) - s.w;
			place(target, c, x, y + h / 2, side, depth + 1, branchOf(c));
			y += h + vGap(depth);
		}
	};

	const place = (
		target: Map<string, Placed>,
		n: TreeNode,
		x: number,
		y: number,
		side: 1 | -1,
		depth: number,
		branch: number,
	) => {
		const s = size(n.id);
		target.set(n.id, {
			x,
			y,
			w: s.w,
			h: s.h,
			depth,
			side,
			branch,
			fromSide: side === 1 ? 'right' : 'left',
			toSide: side === 1 ? 'left' : 'right',
		});
		placeChildren(target, kids(n), x, s.w, y, side, depth, () => branch);
	};

	const rs = size(root.id);
	const rx = -rs.w / 2;
	out.set(root.id, { x: rx, y: 0, w: rs.w, h: rs.h, depth: 0, side: 1, branch: -1 });
	const ch = kids(root);
	ch.forEach((c) => measure(c, 1));
	const branchOf = (c: TreeNode) => ch.indexOf(c);

	if (opt.mode === 'timeline') {
		const indent = 36;
		let x = rx + rs.w + hGap(0);
		ch.forEach((ev, i) => {
			const es = size(ev.id);
			out.set(ev.id, {
				x,
				y: 0,
				w: es.w,
				h: es.h,
				depth: 1,
				side: 1,
				branch: i,
				fromSide: 'right',
				toSide: 'left',
				edgeFrom: i ? ch[i - 1].id : undefined,
			});
			// Details stack away from the axis, reading top→bottom on both sides.
			const up = i % 2 === 1;
			const details = kids(ev);
			const dx = x + es.w / 2 + indent;
			let cursor = up ? -es.h / 2 - opt.vGap * 1.5 : es.h / 2 + opt.vGap * 1.5;
			let right = x + es.w;
			for (const d of up ? [...details].reverse() : details) {
				const h = heights.get(d.id)!;
				const cy = up ? cursor - h / 2 : cursor + h / 2;
				place(out, d, dx, cy, 1, 2, i);
				const p = out.get(d.id)!;
				p.fromSide = up ? 'top' : 'bottom';
				p.toSide = 'left';
				right = Math.max(right, subtreeRight(d));
				cursor = up ? cursor - h - opt.vGap : cursor + h + opt.vGap;
			}
			x = right + hGap(0);
		});
		return out;
	}

	let right = ch;
	let left: TreeNode[] = [];
	if (opt.mode === 'mindmap' && ch.length > 1) {
		const total = ch.reduce((a, c) => a + heights.get(c.id)!, 0);
		let best = 1;
		let bestDiff = Infinity;
		let acc = 0;
		for (let s = 1; s <= ch.length; s++) {
			acc += heights.get(ch[s - 1].id)!;
			const diff = Math.abs(2 * acc - total);
			if (diff < bestDiff) {
				best = s;
				bestDiff = diff;
			}
		}
		right = ch.slice(0, best);
		left = ch.slice(best);
	}
	placeChildren(out, right, rx, rs.w, 0, 1, 0, branchOf);
	placeChildren(out, left, rx, rs.w, 0, -1, 0, branchOf);
	return out;
}
