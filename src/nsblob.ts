const { blake2sHex } = require('blakejs');
import { getConfig } from 'doge-config';
import fs from 'fs';
import { direct, NodeSiteClient, rawwrite } from 'nodesite.eu';
import path from 'path';

const config = getConfig('nsblob', {
	cache_size_limit: 1 << 28,
	file_size_limit: 1 << 24,
	str_internal_error: 'INTERNAL_ERROR',
	str_not_a_file: 'NOT_A_FILE',
});

const { file_size_limit } = config.num;

const ready = NodeSiteClient.ready;

export interface DirMap {
	[filename: string]: string | DirMap;
}

export class nsblob {
	public static cache = new Map<string, Buffer>();
	public static cache_keys = Array<string>();
	public static gc (max_size: number = config.num.cache_size_limit) {
		while (nsblob.cache.size && nsblob.cache_keys.length && (max_size < nsblob.cache_size)) {
			const key = nsblob.cache_keys.shift();
			if (!key) continue;
			if (nsblob.cache_keys.includes(key)) continue;
			const obj = nsblob.cache.get(key);
			nsblob.cache.delete(key);
			if (!obj) continue;
			cache_size.set(nsblob.cache, nsblob.cache_size - obj.length);
		}
		return nsblob.cache_size;
	}
	public static cache_get (hash: string): Buffer | undefined {
		const obj = nsblob.cache.get(hash);
		if (!obj) return;
		nsblob.cache_keys.push(hash);
		return obj;
	}
	public static cache_put (hash: string, obj: Buffer, low_priority: boolean = false) {
		cache_size.set(nsblob.cache, nsblob.cache_size + obj.length);
		nsblob.cache.set(hash, obj);
		low_priority ? nsblob.cache_keys.unshift(hash) : nsblob.cache_keys.push(hash);
		nsblob.gc(config.num.cache_size_limit);
	}
	public static get cache_size (): number {
		return cache_size.get(nsblob.cache) || 0;
	}
	public static set cache_size (max_size: number) {
		nsblob.gc(max_size);
	}
	public static hashmap = new Map<string, string>();
	public static async store (data: Buffer | string, file?: string): Promise<string> {
		data ||= '';
		if (data.length > file_size_limit) {
			return nsblob.store('File was too large.');
		}
		const blake = blake2sHex(data);
		const prehash = nsblob.hashmap.get(blake);
		if (prehash) return prehash;
		return new Promise (resolve => {
			rawwrite('blake2hash', blake);
			direct()?.once(blake, (hash?: string) => {
				if (hash) {
					nsblob.hashmap.set(blake, hash);
					return resolve(hash);
				} else {
					rawwrite('blob2hash', blake, data);
					direct()
					?.once(blake, (hash: string) => resolve(hash))
					?.once(blake, (hash: string) => nsblob.hashmap.set(blake, hash))
				}
			});
		});
	}
	public static async store_file (file: string, dir?: string): Promise<string> {
		const data = await fs.promises.readFile(file);
		return await nsblob.store(data, dir && path.relative(dir, file));
	}
	public static async store_dir (dir: string): Promise<DirMap> {
		const read = await fs.promises.readdir(dir);
		const hashed = await Promise.all(
			read.map(async function fname (fname: string): Promise<[ string, string | DirMap ]> {
				try {
					const pname = path.resolve(dir, fname);
					const stat = await fs.promises.stat(pname);
					if (stat.isDirectory()) {
						return [ fname, await nsblob.store_dir(pname) ];
					} else if (stat.isFile()) {
						return [ fname, await nsblob.store_file(pname, dir) ];
					} else {
						return [ fname, await nsblob.store(config.str.str_not_a_file) ];
					}
				} catch (error) {
					return [ fname, await nsblob.store(config.str.str_internal_error) ];
				}
			})
		);
		hashed.sort(([ a ], [ b ]) => ((a < b) ? -1 : 1))
		const ret: DirMap = {};
		for (const [ name, desc ] of hashed) {
			ret[name] = desc;
		}
		return ret;
	}
	public static async fetch (desc: string): Promise<Buffer> {
		const from_cache = nsblob.cache_get(desc);
		if (from_cache) {
			const ret = Buffer.allocUnsafe(from_cache.length);
			ret.set(from_cache);
			return ret;
		}
		const socket = await ready;
		return new Promise (resolve => {
			socket.emit('request_blob', desc);
			socket.once(desc, (blob: Buffer) => {
				nsblob.cache_put(desc, blob);
				const ret = Buffer.allocUnsafe(blob.length);
				ret.set(blob);
				return resolve(ret);
			});
		});
	}
	public static async store_to_path (desc: string | DirMap, fspath: string): Promise<boolean> {
		try {
			if (typeof desc === 'string') {
				const buf = await nsblob.fetch(desc);
				await fs.promises.writeFile(fspath, buf);
				return true;
			}
			if (!fs.existsSync(fspath)) fs.mkdirSync(fspath, { recursive: true });
			await Promise.all(
				Object.entries(desc)
				.map(async([ name, desc ]) => {
					let new_path = path.resolve(fspath, name);
					if (!new_path.includes(fspath)) new_path = path.resolve(fspath, name.replace(/[^a-z0-9\-]+/gi, ' ').trim().replace(/[^a-z0-9\-]+/gi, '.'));
					return nsblob.store_to_path(desc, new_path);
				})
			);
			return true;
		} catch (error) {
			return false;
		}
	}
}

const cache_size = new WeakMap<typeof nsblob.cache, number>([[ nsblob.cache, 0 ]]);

export default nsblob;
module.exports = nsblob;

Object.assign(nsblob, {
	default: nsblob,
	nsblob,
});
