// Auto-generated via `yarn polkadot-types-from-defs`, do not edit
/* eslint-disable */

import { Compact, Struct } from '@polkadot/types/codec';
import { u32 } from '@polkadot/types/primitive';
import { Balance, BlockNumber } from '@open-web3/orml-types/interfaces/runtime';

/** @name VestingSchedule */
export interface VestingSchedule extends Struct {
  readonly start: BlockNumber;
  readonly period: BlockNumber;
  readonly periodCount: u32;
  readonly perPeriod: Compact<Balance>;
}

/** @name VestingScheduleOf */
export interface VestingScheduleOf extends VestingSchedule {}

export type PHANTOM_VESTING = 'vesting';
