// Stage large attachments on the host in ack-paced chunks so a multi-MB prompt frame
// can't starve the transport heartbeat (which drops the carrier and loses the prompt).
// Small attachments stay inline; large ones are replaced by an { uploadId } reference.
export async function stageAttachments(emit, attachments, { chunkSize, timeoutMs, idPrefix }) {
  const out = [];
  for (let i = 0; i < attachments.length; i++) {
    const att = attachments[i];
    if (!att.content || att.content.length <= chunkSize) { out.push(att); continue; }
    const uploadId = `${idPrefix}_${i}`;
    const total = Math.ceil(att.content.length / chunkSize);
    for (let index = 0; index < total; index++) {
      const content = att.content.slice(index * chunkSize, (index + 1) * chunkSize);
      const res = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), timeoutMs);
        emit({ uploadId, index, total, content }, (r) => { clearTimeout(timer); resolve(r); });
      });
      if (!res?.ok) throw new Error(res?.error || "attachment upload failed");
    }
    out.push({ filename: att.filename, type: att.type, uploadId });
  }
  return out;
}
