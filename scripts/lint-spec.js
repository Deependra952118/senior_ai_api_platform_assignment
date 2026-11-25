import { Validator } from '@seriousme/openapi-schema-validator';
import { SPEC_PATH } from '../src/spec.js';

const validator = new Validator();
const res = await validator.validate(SPEC_PATH);
if (!res.valid) {
  console.error(JSON.stringify(res.errors, null, 2));
  process.exit(1);
}
console.log(`openapi.yaml is valid OpenAPI ${validator.version}`);
