import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { generateKeyPairSync, verify, X509Certificate } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import fixture from "./fixtures/node-forge-nested-digest.mjs";

const require = createRequire(import.meta.url);
const forge = require("node-forge");
const expo = require("@expo/code-signing-certificates");
const selfsigned = require("selfsigned");
// Public exploit fixture from Forge PR #1152, commit ceba34402e329f0365134f23fe19898756527d65.
// Attribution and BSD-3-Clause terms accompany the fixture; no private key is stored.
const invalidDigestInfo = /does not contain a valid RSASSA-PKCS1-v1_5 DigestInfo/;

function verifyForgery(module) {
  const publicKey = module.pki.rsa.setPublicKey(
    new module.jsbn.BigInteger(fixture.modulusHex, 16),
    new module.jsbn.BigInteger(String(fixture.exponent)),
  );
  const digest = module.md.sha256.create().update(fixture.message).digest().getBytes();
  // Default verifier: padding and full signature checks remain enabled.
  return publicKey.verify(digest, module.util.hexToBytes(fixture.signatureHex));
}

function keyPair(exponent = 65537) {
  const pem = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicExponent: exponent,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  return {
    pem,
    privateKey: forge.pki.privateKeyFromPem(pem.privateKey),
    publicKey: forge.pki.publicKeyFromPem(pem.publicKey),
  };
}

function certificate(keys) {
  return expo.generateSelfSignedCodeSigningCertificate({
    keyPair: keys,
    validityNotBefore: new Date(Date.now() - 60_000),
    validityNotAfter: new Date(Date.now() + 86_400_000),
    commonName: "Morse security regression test",
  });
}

test("published nested DigestAlgorithm forgery is rejected by the installed verifier", () => {
  assert.throws(() => verifyForgery(forge), invalidDigestInfo);
});

test("counterfactual: reverting only the guard in a temporary copy restores the exploit", () => {
  const scratch = mkdtempSync(join(tmpdir(), "morse-forge-control-"));
  try {
    // Never modify installed dependencies or the pnpm shared store.
    cpSync(dirname(require.resolve("node-forge/package.json")), scratch, { recursive: true });
    const rsaPath = join(scratch, "lib/rsa.js");
    const patched = readFileSync(rsaPath, "utf8");
    const guard =
      "obj.value.length !== 2 ||\n            obj.value[0].value.length !==\n              (('parameters' in capture) ? 2 : 1)) {";
    assert.equal(patched.split(guard).length, 2, "installed upstream guard must occur once");
    writeFileSync(rsaPath, patched.replace(guard, "obj.value.length !== 2) {"));
    const original = require(join(scratch, "lib/index.js"));
    assert.equal(verifyForgery(original), true, "original 1.4.0 accepts the published forgery");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("Expo CLI, certificate library and selfsigned all resolve the tested patched Forge", () => {
  for (const consumer of ["@expo/cli", "@expo/code-signing-certificates", "selfsigned"]) {
    const consumerRequire = createRequire(require.resolve(`${consumer}/package.json`));
    assert.equal(consumerRequire.resolve("node-forge"), require.resolve("node-forge"), consumer);
  }
});

for (const exponent of [3, 65537]) {
  test(`valid RSA SHA-1/SHA-256 signatures verify with exponent ${exponent}`, () => {
    const keys = keyPair(exponent);
    for (const algorithm of ["sha1", "sha256"]) {
      const message = "Morse valid signature regression";
      const signature = keys.privateKey.sign(forge.md[algorithm].create().update(message));
      const digest = forge.md[algorithm].create().update(message).digest().getBytes();
      assert.equal(keys.publicKey.verify(digest, signature), true);
      assert.equal(
        verify(
          algorithm,
          Buffer.from(message),
          keys.pem.publicKey,
          Buffer.from(signature, "binary"),
        ),
        true,
      );
      const changed = forge.md[algorithm].create().update(`${message}!`).digest().getBytes();
      assert.equal(keys.publicKey.verify(changed, signature), false);
    }
  });
}

test("valid SHA-256 DigestAlgorithm with absent optional NULL is still accepted", () => {
  const keys = keyPair();
  const digest = forge.md.sha256.create().update("optional parameters").digest().getBytes();
  const { asn1 } = forge;
  // Standard DER DigestInfo with OID and no optional parameters; Forge performs signing.
  const algorithm = asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
    asn1.create(
      asn1.Class.UNIVERSAL,
      asn1.Type.OID,
      false,
      asn1.oidToDer(forge.pki.oids.sha256).getBytes(),
    ),
  ]);
  const info = asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
    algorithm,
    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OCTETSTRING, false, digest),
  ]);
  const signature = keys.privateKey.sign(asn1.toDer(info).getBytes(), "NONE");
  assert.equal(keys.publicKey.verify(digest, signature), true);
});

test("certificate verification preserves valid chains and rejects a damaged signature", () => {
  const keys = keyPair();
  const pems = selfsigned.generate([{ name: "commonName", value: "morse-regression.invalid" }], {
    keySize: 2048,
    algorithm: "sha256",
  });
  const cert = forge.pki.certificateFromPem(pems.cert);
  assert.equal(cert.verify(cert), true);
  assert.equal(forge.pki.verifyCertificateChain(forge.pki.createCaStore([cert]), [cert]), true);
  const native = new X509Certificate(pems.cert);
  assert.equal(native.verify(native.publicKey), true);
  const damaged = certificate(keys);
  damaged.signature = "\x00".repeat(damaged.signature.length);
  assert.throws(() => damaged.verify(damaged));
});

test("Expo certificate validation and manifest signing preserve key-match checks", () => {
  const keys = keyPair();
  const cert = certificate(keys);
  const parsed = expo.convertCertificatePEMToCertificate(
    expo.convertCertificateToCertificatePEM(cert),
  );
  assert.doesNotThrow(() => expo.validateSelfSignedCertificate(parsed, keys));
  const message = Buffer.from("Morse test update manifest");
  const signature = expo.signBufferRSASHA256AndVerify(keys.privateKey, parsed, message);
  assert.equal(
    verify("sha256", message, keys.pem.publicKey, Buffer.from(signature, "base64")),
    true,
  );
  const other = keyPair();
  assert.throws(() => expo.validateSelfSignedCertificate(parsed, other), /key pair public key/);
  assert.throws(
    () => expo.validateSelfSignedCertificate(parsed, { ...keys, privateKey: other.privateKey }),
    /keyPair key mismatch/,
  );
  assert.throws(() => expo.signBufferRSASHA256AndVerify(other.privateKey, parsed, message));
});
