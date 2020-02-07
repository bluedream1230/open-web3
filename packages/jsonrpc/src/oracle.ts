import createMethod from '@polkadot/jsonrpc/create/method';
import createParam from '@polkadot/jsonrpc/create/param';

const section = 'oracle';

// FIXME: once polkadotjs fixes the types inconsistency.
// 1. change `getValue` to a concrete type.
// 2. `createParam('key', 'OracleKey')`.
const getValue: any = {
  description: 'Retrieves the oracle value for a given key.',
  params: [
    createParam('key', 'OracleKey' as 'u8')
  ],
  type: 'Option<TimestampedValue>'
};

/**
 * @summary Calls to retrieve oracle data.
 */
export default {
  isDeprecated: false,
  isHidden: false,
  description: 'Retrieves oracle data.',
  section,
  methods: {
    getValue: { ...createMethod(section, 'getValue', getValue), name: 'getValue' }
  }
};
