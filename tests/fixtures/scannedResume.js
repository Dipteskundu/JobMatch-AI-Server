import { createCanvas } from "@napi-rs/canvas";

function createScannedPdf(text, pageCount = 1) {
  const canvas = createCanvas(1224, 1584);
  const context = canvas.getContext("2d");
  context.fillStyle = "#fff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#111";
  context.font = "bold 84px Arial";
  text.split("\n").forEach((line, index) => {
    context.fillText(line, 80, 300 + index * 140);
  });
  const image = canvas.toBuffer("image/jpeg", 90);
  const imageObjectId = 3 + (pageCount * 2);
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${Array.from(
      { length: pageCount },
      (_, index) => `${3 + index * 2} 0 R`,
    ).join(" ")}] /Count ${pageCount} >>`,
  ];

  for (let index = 0; index < pageCount; index += 1) {
    const pageObjectId = 3 + index * 2;
    const contentObjectId = pageObjectId + 1;
    const pageContent = Buffer.from("q 612 0 0 792 0 0 cm /Im0 Do Q\n");
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im0 ${imageObjectId} 0 R >> >> /Contents ${contentObjectId} 0 R >>`,
      Buffer.concat([
        Buffer.from(`<< /Length ${pageContent.length} >>\nstream\n`),
        pageContent,
        Buffer.from("endstream"),
      ]),
    );
  }

  objects.push(Buffer.concat([
    Buffer.from(
      `<< /Type /XObject /Subtype /Image /Width ${canvas.width} /Height ${canvas.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${image.length} >>\nstream\n`,
    ),
    image,
    Buffer.from("\nendstream"),
  ]));

  const chunks = [Buffer.from("%PDF-1.4\n")];
  const offsets = [0];
  let position = chunks[0].length;
  objects.forEach((object, index) => {
    const objectId = index + 1;
    offsets[objectId] = position;
    const body = Buffer.isBuffer(object) ? object : Buffer.from(object);
    const serialized = Buffer.concat([
      Buffer.from(`${objectId} 0 obj\n`),
      body,
      Buffer.from("\nendobj\n"),
    ]);
    chunks.push(serialized);
    position += serialized.length;
  });

  const xrefOffset = position;
  const xref = [
    `xref\n0 ${offsets.length}\n`,
    "0000000000 65535 f \n",
    ...offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`),
  ].join("");
  chunks.push(Buffer.from(
    `${xref}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`,
  ));
  return Buffer.concat(chunks);
}

export { createScannedPdf };
