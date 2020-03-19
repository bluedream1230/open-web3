import { Sequelize, Op, SyncOptions } from 'sequelize';
import init, { Status, Block, Metadata, Extrinsic, Events } from './models';
import Scanner from '../../scanner/src';
import { WsProvider } from '@polkadot/rpc-provider';
import { TypeProvider, ChainInfo, SubscribeBlock } from '../../scanner/src/types';

type IndexerOptions = {
  dbUrl: string;
  wsUrl: string;
  types?: TypeProvider;
  sync?: boolean;
  syncOptions?: SyncOptions;
};

export default class Indexer {
  // eslint-disable-next-line
  protected constructor(private readonly db: Sequelize, private readonly scanner: Scanner) {}
  private metadataVersion: Record<string, any> = {};

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
    const statuses = await Status.findOne({ order: [['blockNumber', 'DESC']] });
    const lastBlockNumber = statuses ? statuses.blockNumber : 0;
    await this.deleteBlocks(lastBlockNumber);

    this.scanner.subscribe({ start: lastBlockNumber, concurrent: 200, confirmation: 4 }).subscribe(result => {
      if (result.result) {
        const block = result.result;
        Promise.all([
          this.syncBlock(block),
          this.syncEvents(block),
          this.syncExtrinsics(block),
          this.syncMetadata(block.chainInfo)
        ])
          .then(() => {
            return this.syncStatus(block.number, block.hash, 0);
          })
          .catch(error => {
            console.log(error);
            return this.syncStatus(block.number, block.hash, 2);
          });
      } else {
        console.error(result.error);
        const blockNumber = result.blockNumber;
        this.syncStatus(blockNumber, null, 1);
      }
    });
  }

  async syncStatus(blockNumber: number, blockHash: string | null, status: number) {
    await Status.upsert({
      blockNumber: blockNumber,
      blockHash: blockHash,
      status: status
    });
  }

  async syncEvents(block: SubscribeBlock['result']) {
    const request = [];
    for (const event of block.events) {
      request.push(
        Events.upsert({
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
        })
      );
    }
    await Promise.all(request);
  }

  async syncBlock(block: SubscribeBlock['result']) {
    await Block.upsert({
      blockHash: block.hash,
      blockNumber: block.number,
      timestamp: block.timestamp,
      parentHash: block.raw.block.header.parentHash,
      author: block.author,
      raw: block.raw
    });
  }

  async syncExtrinsics(block: SubscribeBlock['result']) {
    const request = [];
    for (const extrinsic of block.extrinsics) {
      request.push(
        Extrinsic.upsert({
          id: `${block.number}-${extrinsic.index}`,
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
          bytes: extrinsic.bytes
        })
      );
    }
    await Promise.all(request);
  }

  async syncMetadata(chainInfo: ChainInfo) {
    if (!this.metadataVersion[chainInfo.id]) {
      const info = chainInfo;
      this.metadataVersion[info.id] = Metadata.upsert({
        id: info.id,
        minBlockNumber: info.min,
        maxBlockNumber: info.max,
        bytes: info.bytes,
        json: info.metadata.metadata.toJSON(),
        runtimeVersion: info.runtimeVersion
      });
    } else {
      await this.metadataVersion[chainInfo.id];
      const find = await Metadata.findOne({
        where: {
          id: chainInfo.id
        },
        attributes: ['id', 'minBlockNumber', 'maxBlockNumber']
      });

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
      }),
      Status.destroy({
        where: { blockNumber: blockNumber }
      })
    ]);
  }

  close(): void {
    this.db.close();
  }
}
