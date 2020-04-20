import { Sequelize, Op, SyncOptions } from 'sequelize';
import { Registry } from '@polkadot/types/types';
import { WsProvider } from '@polkadot/rpc-provider';
import { auditTime, mergeMap } from 'rxjs/operators';
import Scanner from '@orml/scanner';
import {
  TypeProvider,
  ChainInfo,
  SubscribeBlock,
  SubscribeBlockError,
  DispatchableCall as DispatchableCallType
} from '@orml/scanner/types';

import init, { Status, Block, Metadata, Extrinsic, Events, DispatchableCall } from './models';
import log from './log';

export type IndexerOptions = {
  dbUrl: string;
  wsUrl: string;
  types?: TypeProvider;
  sync?: boolean;
  syncOptions?: SyncOptions;
};

export default class Indexer {
  // eslint-disable-next-line
  protected constructor(private readonly db: Sequelize, private readonly scanner: Scanner) {}

  static async create(options: IndexerOptions): Promise<Indexer> {
    const db = new Sequelize(options.dbUrl, {
      logging: false
    });
    await db.authenticate();
    const wsProvider = new WsProvider(options.wsUrl);

    init(db);
    if (options.sync) {
      await db.sync(options.syncOptions);
    }

    return new Indexer(db, new Scanner({ wsProvider, types: options.types }));
  }

  async start(): Promise<void> {
    const statuses = (await Status.findOne({ where: { status: 0 }, order: [['blockNumber', 'DESC']] })) as any;
    const lastBlockNumber = statuses ? Number(statuses.blockNumber) : 0;

    await this.fixLostBlock(lastBlockNumber);

    const source$ = this.scanner.subscribe({ start: lastBlockNumber, concurrent: 100, confirmation: 4 });

    source$.pipe(mergeMap((result) => this.pushData(result), 5)).subscribe();

    source$.pipe(auditTime(4000 * 10)).subscribe(() => {
      for (const id of Object.keys(this.scanner.chainInfo)) {
        this.syncMetadata(this.scanner.chainInfo[id]);
      }
    });

    // eslint-disable-next-line
    source$.pipe(auditTime(3999)).subscribe(async () => {
      const blockNumbers = await this.queryFailBlock();
      for (const number of blockNumbers) {
        await this.deleteBlock(number);
        const blockDetail = await this.getBlock(number);
        await this.pushData(blockDetail);
      }
    });

    // affect performance
    // source$
    //   .pipe(
    //     auditTime(3999),
    //     pairwise(),
    //     mergeMap(([pre, current]) => {
    //       return this.fixLostBlock(Number(current.blockNumber), Number(pre.blockNumber));
    //     })
    //   )
    //   .subscribe();
  }

  async fixLostBlock(lastBlockNumber: number, low = 0) {
    if (!low) {
      if (!(await this.noMissBlock(low))) {
        low = 0;
      }
    }

    while (!(await this.noMissBlock(lastBlockNumber))) {
      const start = await this.findFirstLostBlock(lastBlockNumber, low);
      if (start < 0) return;
      const end = Math.min(start + 200, lastBlockNumber);
      const source$ = this.scanner.subscribe({ start, end, concurrent: 50, confirmation: 4 }).pipe(
        mergeMap((result) => {
          return this.pushData(result);
        })
      );

      source$.subscribe();

      await source$.toPromise();

      if (await this.noMissBlock(end)) {
        low = end;
      } else {
        low = start;
      }
    }
  }

  async findFirstLostBlock(high: number, low = 0) {
    if (await this.noMissBlock(high)) return -1;

    let result = low;

    while (high - low > 200) {
      const mid = low + ((high - low) >> 2);
      const value = await this.noMissBlock(mid);

      if (value) {
        result = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }

    log.warn(`From ${result}`);
    return result;
  }

  async noMissBlock(blockNumber: number) {
    const count = await Status.count({
      where: {
        blockNumber: {
          [Op.lt]: blockNumber
        }
      }
    });
    return count === blockNumber;
  }

  async pushData(result: SubscribeBlock | SubscribeBlockError) {
    try {
      if (result.result) {
        const t = await this.db.transaction();

        const block = result.result;
        await Promise.all([
          this.syncBlock(block, { transaction: t }),
          this.syncEvents(block, { transaction: t }),
          this.syncExtrinsics(block, { transaction: t }),
          this.syncDispatchableCalls(block, { transaction: t }),
          this.syncStatus(block.number, block.hash, 0, { transaction: t })
        ])
          .then(() => {
            return t.commit();
          })
          .then(() => {
            return log.info(`${block.number}-${block.hash}`);
          })
          .catch(async (error) => {
            t.rollback();
            log.error(`${block.number}-${block.hash}`, error, { errorCode: 2 });
            await this.syncStatus(block.number, block.hash, 2);
          });
      } else {
        log.error(`${result.blockNumber}-unknown`, result.error, { errorCode: 1 });

        const blockNumber = result.blockNumber;
        this.syncStatus(blockNumber, null, 1);
      }
    } catch (error) {
      log.error(`${result.blockNumber}`, error);
    }
  }

  async queryFailBlock(limit = 10) {
    const result = await Status.findAll({
      where: { status: { [Op.not]: 0 } },
      limit,
      order: [['updatedAt', 'asc']],
      attributes: ['blockNumber']
    });
    return result.map((r) => r.toJSON()).map((r: any) => Number(r.blockNumber));
  }

  async getBlock(blockNumber: number) {
    let result: SubscribeBlock | SubscribeBlockError;
    log.warn(`${blockNumber} retry`);

    try {
      const blockDetail = await this.scanner.getBlockDetail({ blockNumber });
      result = {
        blockNumber: blockDetail.number,
        result: blockDetail,
        error: null
      };
    } catch (error) {
      result = {
        blockNumber: blockNumber,
        error: error,
        result: null
      };
    }

    return result;
  }

  async syncStatus(blockNumber: number, blockHash: string | null, status: number, options?: any) {
    await Status.upsert(
      {
        blockNumber: blockNumber,
        blockHash: blockHash,
        status: status
      },
      options || {}
    );
  }

  async syncEvents(block: SubscribeBlock['result'], options: any) {
    const request: any[] = [];
    for (const event of block.events) {
      request.push(
        Events.upsert(
          {
            id: `${block.number}-${event.index}`,
            blockHash: block.hash,
            blockNumber: block.number,
            index: event.index,
            section: event.section,
            method: event.method,
            args: event.args,
            bytes: event.bytes,
            phaseType: event.phaseType,
            phaseIndex: event.phaseIndex
          },
          options
        )
      );
    }
    await Promise.all(request);
  }

  async syncBlock(block: SubscribeBlock['result'], options: any) {
    await Block.upsert(
      {
        blockHash: block.hash,
        blockNumber: block.number,
        timestamp: block.timestamp,
        parentHash: block.raw.block.header.parentHash,
        author: block.author,
        raw: block.raw
      },
      options
    );
  }

  async syncExtrinsics(block: SubscribeBlock['result'], options: any) {
    const request: any[] = [];
    for (const extrinsic of block.extrinsics) {
      request.push(
        Extrinsic.upsert(
          {
            id: `${block.hash}-${extrinsic.index}`,
            hash: extrinsic.hash,
            blockHash: block.hash,
            blockNumber: block.number,
            index: extrinsic.index,
            section: extrinsic.section,
            method: extrinsic.method,
            args: extrinsic.args,
            nonce: extrinsic.nonce,
            tip: extrinsic.tip,
            signer: extrinsic.signer,
            result: extrinsic.result,
            bytes: extrinsic.bytes
          },
          options
        )
      );
    }
    await Promise.all(request);
  }

  async syncDispatchableCalls(block: SubscribeBlock['result'], options: any) {
    type ChildCall = {
      args: any;
      callIndex: 'string';
    };

    const promises: Promise<any>[] = [];
    let registry: Registry;

    const decodeCallIndex = (callIndex: string) => {
      if (!registry) {
        registry = block.chainInfo.registry;
      }
      const callIndexNum = parseInt(callIndex, 16);
      const sectionIndex = callIndexNum >> 8;
      const methodIndex = callIndexNum & 0xff;
      const call = registry.findMetaCall(new Uint8Array([sectionIndex, methodIndex]));
      return {
        section: call.section.toString(),
        method: call.method.toString()
      };
    };

    const handle = (
      call: DispatchableCallType,
      parentId: string | null,
      childIndex: number | null,
      extrinsic: SubscribeBlock['result']['extrinsics'][0]
    ) => {
      const extrinsicId = `${block.hash}-${extrinsic.index}`;
      const id = parentId ? `${parentId}-${childIndex}` : extrinsicId;

      promises.push(
        DispatchableCall.upsert(
          {
            id,
            section: call.section,
            method: call.method,
            args: call.args,
            extrinsic: extrinsicId,
            parent: parentId,
            origin: extrinsic.signer
          },
          options
        )
      );

      if (call.section === 'utility' && call.method === 'batch') {
        const calls = call.args.calls as ChildCall[];
        calls.forEach((childCall, idx) => {
          const { section, method } = decodeCallIndex(childCall.callIndex);
          handle(
            {
              callIndex: childCall.callIndex,
              section,
              method,
              args: childCall.args
            },
            id,
            idx,
            extrinsic
          );
        });
      } else if (call.section === 'sudo' && call.method === 'sudo') {
        const childCall = call.args.call as ChildCall;
        const { section, method } = decodeCallIndex(childCall.callIndex);
        handle(
          {
            callIndex: childCall.callIndex,
            section,
            method,
            args: childCall.args
          },
          id,
          0,
          extrinsic
        );
      }
    };
    for (const extrinsic of block.extrinsics) {
      handle(extrinsic, null, null, extrinsic);
    }
    return Promise.all(promises);
  }

  async syncMetadata(chainInfo: ChainInfo) {
    const find = (await Metadata.findOne({
      where: {
        id: chainInfo.id
      },
      attributes: ['id', 'minBlockNumber', 'maxBlockNumber']
    })) as any;

    if (!find) {
      await Metadata.upsert({
        id: chainInfo.id,
        minBlockNumber: chainInfo.min,
        maxBlockNumber: chainInfo.max,
        bytes: chainInfo.bytes,
        json: chainInfo.metadata.metadata.toJSON(),
        runtimeVersion: chainInfo.runtimeVersion
      });
    } else {
      await find.update({
        minBlockNumber: Math.min(chainInfo.min, find.minBlockNumber),
        maxBlockNumber: Math.max(chainInfo.max, find.maxBlockNumber)
      });
    }
  }

  async deleteBlocks(minBlockNumber: number) {
    await Promise.all([
      Block.destroy({
        where: { blockNumber: { [Op.gte]: minBlockNumber } }
      }),
      Events.destroy({
        where: { blockNumber: { [Op.gte]: minBlockNumber } }
      }),
      Extrinsic.destroy({
        where: { blockNumber: { [Op.gte]: minBlockNumber } }
      }),
      Status.destroy({
        where: { blockNumber: { [Op.gte]: minBlockNumber } }
      })
    ]);
  }

  async deleteBlock(blockNumber: number) {
    await Promise.all([
      Block.destroy({
        where: { blockNumber: blockNumber }
      }),
      Events.destroy({
        where: { blockNumber: blockNumber }
      }),
      Extrinsic.destroy({
        where: { blockNumber: blockNumber }
      })
    ]);
  }

  close(): void {
    this.db.close();
  }
}
