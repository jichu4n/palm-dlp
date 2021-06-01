import debug from 'debug';
import net, {Server, Socket} from 'net';
import {
  DlpAddSyncLogEntryRequest,
  DlpCloseDBRequest,
  DlpEndOfSyncRequest,
  DlpOpenConduitRequest,
  DlpOpenDBRequestArg,
  DlpOpenDBRequest,
  DlpOpenMode,
  DlpReadOpenDBInfoRequest,
  DlpReadRecordIDListRequestArg,
  DlpReadRecordIDListRequest,
} from './dlp-commands';
import {DlpConnection} from './dlp-protocol';
import {
  createNetSyncDatagramStream,
  NetSyncDatagramStream,
} from './net-sync-protocol';

/** HotSync port to listen on. */
export const HOTSYNC_DATA_PORT = 14238;

/** Handshake request 1 from client to server. */
export const HOTSYNC_HANDSHAKE_REQUEST_1 = Buffer.from([
  0x90, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x20, 0x00, 0x00, 0x00,
  0x08, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
]);
/** Handshake response 1 from server to client. */
export const HOTSYNC_HANDSHAKE_RESPONSE_1 = Buffer.from([
  0x12, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x20, 0x00, 0x00, 0x00,
  0x24, 0xff, 0xff, 0xff, 0xff, 0x3c, 0x00, 0x3c, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0xc0, 0xa8, 0x01, 0x21, 0x04, 0x27, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
]);
/** Handshake request 2 from client to server. */
export const HOTSYNC_HANDSHAKE_REQUEST_2 = Buffer.from([
  0x92, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x20, 0x00, 0x00, 0x00,
  0x24, 0xff, 0xff, 0xff, 0xff, 0x00, 0x3c, 0x00, 0x3c, 0x40, 0x00, 0x00, 0x00,
  0x01, 0x00, 0x00, 0x00, 0xc0, 0xa8, 0xa5, 0x1e, 0x04, 0x01, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
]);
/** Handshake response 2 from server to client. */
export const HOTSYNC_HANDSHAKE_RESPONSE_2 = Buffer.from([
  0x13, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x20, 0x00, 0x00, 0x00,
  0x20, 0xff, 0xff, 0xff, 0xff, 0x00, 0x3c, 0x00, 0x3c, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
]);
/** Handshake request 3 from client to server. */
export const HOTSYNC_HANDSHAKE_REQUEST_3 = Buffer.from([
  0x93, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
]);

export class NetSyncServer {
  start() {
    if (this.server) {
      throw new Error('Server already started');
    }
    this.server = net.createServer(this.onConnection.bind(this));
    this.server.listen(HOTSYNC_DATA_PORT, () => {
      this.log(`Server started on port ${HOTSYNC_DATA_PORT}`);
    });
  }

  async onConnection(socket: Socket) {
    const connection = new NetSyncConnection(socket);
    await connection.doHandshake();

    // TODO: Conduit framework
    await connection.dlpConnection.execute(DlpOpenConduitRequest.create());
    const {dbHandle} = await connection.dlpConnection.execute(
      DlpOpenDBRequest.create({
        arg: DlpOpenDBRequestArg.create({
          mode: DlpOpenMode.READ,
          name: 'MemoDB',
        }),
      })
    );
    const {numRecords} = await connection.dlpConnection.execute(
      DlpReadOpenDBInfoRequest.create({dbHandle})
    );
    this.log(`Number of records in MemoDB: ${numRecords}`);
    const {recordIds} = (
      await connection.dlpConnection.execute(
        DlpReadRecordIDListRequest.create({
          arg: DlpReadRecordIDListRequestArg.create({
            dbHandle,
            maxNumRecords: 500,
          }),
        })
      )
    ).arg;
    this.log(`Record IDs: ${recordIds.join(' ')}`);
    await connection.dlpConnection.execute(
      DlpCloseDBRequest.create({dbHandle})
    );

    await connection.end();
  }

  private server: Server | null = null;
  private log = debug('NetSync');
}

export class NetSyncConnection {
  /** DLP connection for communicating with this sync session. */
  dlpConnection: DlpConnection;

  constructor(socket: Socket) {
    this.log = debug('NetSync').extend(socket.remoteAddress ?? 'UNKNOWN');
    this.netSyncDatagramStream = createNetSyncDatagramStream(socket);
    this.dlpConnection = new DlpConnection(this.netSyncDatagramStream);

    this.log(`Connection received`);

    socket.setNoDelay(true);

    socket.on('close', (hadError) => {
      this.log(`Connection closed${hadError ? 'with errors' : ''}`);
    });

    socket.on('error', (e) => {
      this.log(`Error: ${e.message}`);
    });
  }

  async doHandshake() {
    this.log('Starting handshake');
    await this.netSyncDatagramStream.readAsync(
      HOTSYNC_HANDSHAKE_REQUEST_1.length
    );
    this.netSyncDatagramStream.write(HOTSYNC_HANDSHAKE_RESPONSE_1);
    await this.netSyncDatagramStream.readAsync(
      HOTSYNC_HANDSHAKE_REQUEST_2.length
    );
    this.netSyncDatagramStream.write(HOTSYNC_HANDSHAKE_RESPONSE_2);
    await this.netSyncDatagramStream.readAsync(
      HOTSYNC_HANDSHAKE_REQUEST_3.length
    );
    this.log('Handshake complete');
  }

  async end() {
    await this.dlpConnection.execute(
      DlpAddSyncLogEntryRequest.create({
        message: 'Thank you for using Palmira!',
      })
    );
    await this.dlpConnection.execute(DlpEndOfSyncRequest.create());
  }

  private log: debug.Debugger;
  private netSyncDatagramStream: NetSyncDatagramStream;
}

if (require.main === module) {
  const netSyncServer = new NetSyncServer();
  netSyncServer.start();
}