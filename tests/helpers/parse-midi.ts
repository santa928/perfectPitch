import assert from 'node:assert/strict'

type ParsedEvent = { tick: number; status: number; type?: number; data: number[]; deltaBytes: number[] }

/** 出力writerとは独立してSMFのチャンク、VLQ、イベント長を検査する最小parser。 */
export function parseMidi(bytes: Uint8Array): { format: number; tracks: number; ppq: number; events: ParsedEvent[] } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const tag = (offset: number): string => String.fromCharCode(...bytes.slice(offset, offset + 4))
  assert.equal(tag(0), 'MThd')
  assert.equal(view.getUint32(4), 6)
  const format = view.getUint16(8), tracks = view.getUint16(10), ppq = view.getUint16(12)
  assert.equal(tag(14), 'MTrk')
  const end = 22 + view.getUint32(18)
  assert.equal(end, bytes.length)
  let offset = 22, tick = 0
  /** 最大4byteのVLQを読み、区切りを越える不正なイベントを拒否する。 */
  const vlq = (): number => {
    let value = 0
    for (let i = 0; i < 4; i++) {
      assert.ok(offset < end)
      const byte = bytes[offset++]
      value = value * 128 + (byte & 127)
      if (byte < 128) return value
    }
    assert.fail('VLQ exceeds four bytes')
  }
  const events: ParsedEvent[] = []
  while (offset < end) {
    const start = offset
    tick += vlq()
    const deltaBytes = [...bytes.slice(start, offset)], status = bytes[offset++]
    if (status === 0xff) {
      const type = bytes[offset++], size = vlq()
      const data = [...bytes.slice(offset, offset + size)]
      offset += size
      events.push({ tick, status, type, data, deltaBytes })
    } else {
      assert.ok([0x80, 0x90, 0xc0].includes(status))
      const size = status === 0xc0 ? 1 : 2
      const data = [...bytes.slice(offset, offset + size)]
      assert.ok(data.every(byte => byte < 128))
      offset += size
      events.push({ tick, status, data, deltaBytes })
    }
    assert.ok(offset <= end)
  }
  assert.equal(events.at(-1)?.type, 0x2f)
  return { format, tracks, ppq, events }
}
