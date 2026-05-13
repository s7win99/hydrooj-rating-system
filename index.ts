import {
    Context, Handler, ObjectId, PERM, PRIV, Types, ValidationError,
    NotFoundError, UserModel, db, param, query,
} from 'hydrooj';
import { readFile } from 'fs/promises';

export interface RatingDoc {
    _id: ObjectId;
    uid: number;
    internalRating: number;
    displayRating: number;
    maxDisplayRating: number;
    contestCount: number;
    lastUpdate: Date;
}

export interface RatingHistoryDoc {
    _id: ObjectId;
    uid: number;
    contestName: string;
    oldInternalRating: number;
    newInternalRating: number;
    oldDisplayRating: number;
    newDisplayRating: number;
    rank: number;
    date: Date;
}

export interface RatingArchiveParticipant {
    uid: number;
    username: string;
    oldInternalRating: number;
    newInternalRating: number;
    oldDisplayRating: number;
    newDisplayRating: number;
    rank?: number;
    oldRank?: number;
    newRank?: number;
    historyDate?: Date;
}

export interface RatingArchiveDoc {
    _id: ObjectId;
    contestName: string;
    operationType: 'contest' | 'manual';
    operationDate: Date;
    participants: RatingArchiveParticipant[];
    operatorUid?: number;
    description?: string;
}

declare module 'hydrooj' {
    interface Model {
        rating: typeof RatingModel;
    }
    interface Collections {
        rating: RatingDoc;
        ratingHistory: RatingHistoryDoc;
        ratingArchive: RatingArchiveDoc;
    }
}

const ratingColl = db.collection('rating');
const ratingHistoryColl = db.collection('ratingHistory');
const ratingArchiveColl = db.collection('ratingArchive');

const INITIAL_INTERNAL_RATING = 1200;
const INITIAL_DISPLAY_RATING = 1000;
const DEFAULT_PAIRWISE_ELO_K = 80;
const DEFAULT_MAX_DELTA = 80;
const MAX_RATING_VALUE = 5000;

type RatingPublicView = {
    rating: number;
    maxRating: number;
    contestCount: number;
    lastUpdate?: Date;
};

type RatingHistoryPublicView = {
    _id: ObjectId;
    uid: number;
    contestName: string;
    oldRating: number;
    newRating: number;
    rank: number;
    date: Date;
};

type PairwiseParticipant = {
    uid: number;
    username: string;
    rank: number;
    oldInternalRating: number;
    oldDisplayRating: number;
    oldContestCount: number;
};

type PairwiseResult = PairwiseParticipant & {
    internalDelta: number;
    newInternalRating: number;
    newDisplayRating: number;
    newContestCount: number;
};

type RatingUpdateInput = {
    uid: number;
    contestName: string;
    rank: number;
    oldInternalRating: number;
    newInternalRating: number;
    oldDisplayRating: number;
    newDisplayRating: number;
    contestCount: number;
    date?: Date;
};

type RatingAdminTab = 'manual' | 'contest' | 'users';

type RatingAdminStats = {
    totalUsers: number;
    ratedUsers: number;
    contestUsers: number;
    avgRating: number;
    maxRating: number;
    activeUsers: number;
    lastOperationAt: Date | null;
};

function clampRating(value: number): number {
    return Math.max(0, Math.min(MAX_RATING_VALUE, Math.round(value)));
}

function getDisplayOffset(count: number): number {
    const ratedCount = Math.max(0, Math.floor(count));
    if (ratedCount === 0) return 200;
    if (ratedCount === 1) return 120;
    if (ratedCount === 2) return 70;
    if (ratedCount === 3) return 40;
    if (ratedCount === 4) return 15;
    return 0;
}

function calcDisplayRating(internalRating: number, ratedContestCount: number): number {
    return Math.max(0, clampRating(internalRating) - getDisplayOffset(ratedContestCount));
}

function createInitialRatingState(uid: number, displayRating = INITIAL_DISPLAY_RATING): RatingDoc {
    const normalizedDisplay = clampRating(displayRating);
    return {
        _id: new ObjectId(),
        uid,
        internalRating: clampRating(normalizedDisplay + getDisplayOffset(0)),
        displayRating: normalizedDisplay,
        maxDisplayRating: normalizedDisplay,
        contestCount: 0,
        lastUpdate: new Date(),
    };
}

function normalizeRatingDoc(doc: any, uid?: number): RatingDoc {
    if (!doc) return createInitialRatingState(uid || 0);
    if (typeof doc.internalRating === 'number' && typeof doc.displayRating === 'number') {
        return {
            _id: doc._id || new ObjectId(),
            uid: doc.uid ?? uid ?? 0,
            internalRating: clampRating(doc.internalRating),
            displayRating: clampRating(doc.displayRating),
            maxDisplayRating: clampRating(doc.maxDisplayRating ?? doc.displayRating),
            contestCount: Math.max(0, Math.floor(doc.contestCount || 0)),
            lastUpdate: doc.lastUpdate ? new Date(doc.lastUpdate) : new Date(),
        };
    }

    const displayRating = clampRating(doc.rating ?? INITIAL_DISPLAY_RATING);
    const contestCount = Math.max(0, Math.floor(doc.contestCount || 0));
    return {
        _id: doc._id || new ObjectId(),
        uid: doc.uid ?? uid ?? 0,
        internalRating: clampRating(displayRating + getDisplayOffset(contestCount)),
        displayRating,
        maxDisplayRating: clampRating(doc.maxRating ?? displayRating),
        contestCount,
        lastUpdate: doc.lastUpdate ? new Date(doc.lastUpdate) : new Date(),
    };
}

function normalizeHistoryDoc(doc: any): RatingHistoryDoc {
    if (
        typeof doc.oldInternalRating === 'number'
        && typeof doc.newInternalRating === 'number'
        && typeof doc.oldDisplayRating === 'number'
        && typeof doc.newDisplayRating === 'number'
    ) {
        return {
            _id: doc._id || new ObjectId(),
            uid: doc.uid,
            contestName: String(doc.contestName || ''),
            oldInternalRating: clampRating(doc.oldInternalRating),
            newInternalRating: clampRating(doc.newInternalRating),
            oldDisplayRating: clampRating(doc.oldDisplayRating),
            newDisplayRating: clampRating(doc.newDisplayRating),
            rank: Math.max(0, Math.floor(doc.rank || 0)),
            date: doc.date ? new Date(doc.date) : new Date(),
        };
    }

    const oldDisplayRating = clampRating(doc.oldRating ?? INITIAL_DISPLAY_RATING);
    const newDisplayRating = clampRating(doc.newRating ?? oldDisplayRating);
    const rank = Math.max(0, Math.floor(doc.rank || 0));
    const oldCount = 0;
    const newCount = oldCount + (rank > 0 ? 1 : 0);
    return {
        _id: doc._id || new ObjectId(),
        uid: doc.uid,
        contestName: String(doc.contestName || ''),
        oldInternalRating: clampRating(oldDisplayRating + getDisplayOffset(oldCount)),
        newInternalRating: clampRating(newDisplayRating + getDisplayOffset(newCount)),
        oldDisplayRating,
        newDisplayRating,
        rank,
        date: doc.date ? new Date(doc.date) : new Date(),
    };
}

function normalizeArchiveParticipant(doc: any): RatingArchiveParticipant {
    if (
        typeof doc.oldInternalRating === 'number'
        && typeof doc.newInternalRating === 'number'
        && typeof doc.oldDisplayRating === 'number'
        && typeof doc.newDisplayRating === 'number'
    ) {
        return {
            uid: doc.uid,
            username: String(doc.username || ''),
            oldInternalRating: clampRating(doc.oldInternalRating),
            newInternalRating: clampRating(doc.newInternalRating),
            oldDisplayRating: clampRating(doc.oldDisplayRating),
            newDisplayRating: clampRating(doc.newDisplayRating),
            rank: doc.rank,
            oldRank: doc.oldRank,
            newRank: doc.newRank,
            historyDate: doc.historyDate ? new Date(doc.historyDate) : undefined,
        };
    }

    const oldDisplayRating = clampRating(doc.oldRating ?? INITIAL_DISPLAY_RATING);
    const newDisplayRating = clampRating(doc.newRating ?? oldDisplayRating);
    const rank = typeof doc.rank === 'number' ? doc.rank : undefined;
    const oldCount = 0;
    const newCount = rank && rank > 0 ? 1 : 0;
    return {
        uid: doc.uid,
        username: String(doc.username || ''),
        oldInternalRating: clampRating(oldDisplayRating + getDisplayOffset(oldCount)),
        newInternalRating: clampRating(newDisplayRating + getDisplayOffset(newCount)),
        oldDisplayRating,
        newDisplayRating,
        rank,
        oldRank: doc.oldRank,
        newRank: doc.newRank,
        historyDate: doc.historyDate ? new Date(doc.historyDate) : undefined,
    };
}

function toPublicRating(doc?: RatingDoc | null): RatingPublicView {
    const normalized = doc ? normalizeRatingDoc(doc) : createInitialRatingState(0);
    return {
        rating: normalized.displayRating,
        maxRating: normalized.maxDisplayRating,
        contestCount: normalized.contestCount,
        lastUpdate: normalized.lastUpdate,
    };
}

function toPublicHistory(doc: RatingHistoryDoc): RatingHistoryPublicView {
    const normalized = normalizeHistoryDoc(doc);
    return {
        _id: normalized._id,
        uid: normalized.uid,
        contestName: normalized.contestName,
        oldRating: normalized.oldDisplayRating,
        newRating: normalized.newDisplayRating,
        rank: normalized.rank,
        date: normalized.date,
    };
}

function toPublicArchive(archive: any): any {
    return {
        ...archive,
        participants: (archive.participants || []).map((participant: any) => {
            const normalized = normalizeArchiveParticipant(participant);
            return {
                ...normalized,
                oldRating: normalized.oldDisplayRating,
                newRating: normalized.newDisplayRating,
            };
        }),
    };
}

function normalizeRatingAdminTab(tab?: string): RatingAdminTab {
    if (tab === 'manual' || tab === 'contest' || tab === 'users') return tab;
    return 'manual';
}

async function getRatingAdminStats(): Promise<RatingAdminStats> {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const [totalUsers, ratedUsers, contestUsers, avgRating, maxRating, activeUsers, lastArchive] = await Promise.all([
        UserModel.coll.countDocuments({}),
        ratingColl.countDocuments({}),
        ratingColl.countDocuments({ contestCount: { $gt: 0 } }),
        ratingColl.aggregate([{ $group: { _id: null, avgRating: { $avg: '$displayRating' } } }]).toArray(),
        ratingColl.findOne({}, { sort: { displayRating: -1 } }),
        ratingColl.countDocuments({ lastUpdate: { $gte: thirtyDaysAgo } }),
        ratingArchiveColl.findOne({}, { sort: { operationDate: -1 } }),
    ]);

    return {
        totalUsers,
        ratedUsers,
        contestUsers,
        avgRating: avgRating[0]?.avgRating || 0,
        maxRating: maxRating?.displayRating || 0,
        activeUsers,
        lastOperationAt: lastArchive?.operationDate ? new Date(lastArchive.operationDate) : null,
    };
}

function calculatePairwiseEloChanges(
    participants: PairwiseParticipant[],
    k = DEFAULT_PAIRWISE_ELO_K,
    maxDelta = DEFAULT_MAX_DELTA,
): PairwiseResult[] {
    if (participants.length < 2) {
        throw new ValidationError('At least 2 participants are required for rating calculation');
    }

    return participants.map((current) => {
        let actual = 0;
        let expected = 0;
        for (const other of participants) {
            if (other.uid === current.uid) continue;
            expected += 1 / (1 + 10 ** ((other.oldInternalRating - current.oldInternalRating) / 400));
            if (current.rank < other.rank) actual += 1;
            else if (current.rank === other.rank) actual += 0.5;
        }

        const rawDelta = Math.round(k * (actual - expected) / (participants.length - 1));
        const internalDelta = Math.max(-maxDelta, Math.min(maxDelta, rawDelta));
        const newInternalRating = clampRating(current.oldInternalRating + internalDelta);
        const newContestCount = current.oldContestCount + 1;
        return {
            ...current,
            internalDelta,
            newInternalRating,
            newDisplayRating: calcDisplayRating(newInternalRating, newContestCount),
            newContestCount,
        };
    }).sort((a, b) => a.rank - b.rank || a.username.localeCompare(b.username));
}

export class RatingModel {
    static async get(uid: number): Promise<RatingDoc | null> {
        const rating = await ratingColl.findOne({ uid });
        return rating ? normalizeRatingDoc(rating, uid) : null;
    }

    static async getRank(uid: number): Promise<number> {
        const rating = await this.get(uid);
        if (!rating) return 0;
        return await ratingColl.countDocuments({ displayRating: { $gt: rating.displayRating } }) + 1;
    }

    static async getLeaderboard(page = 1, limit = 50): Promise<RatingDoc[]> {
        const ratings = await ratingColl
            .find({ contestCount: { $gt: 0 } })
            .sort({ displayRating: -1 })
            .skip((page - 1) * limit)
            .limit(limit)
            .toArray();
        return ratings.map((rating) => normalizeRatingDoc(rating));
    }

    static async getLeaderboardCount(): Promise<number> {
        return await ratingColl.countDocuments({ contestCount: { $gt: 0 } });
    }

    static async updateRating(input: RatingUpdateInput): Promise<void> {
        if (input.uid <= 0) throw new ValidationError('Invalid user ID');
        if (!input.contestName.trim()) throw new ValidationError('Contest name cannot be empty');
        if (input.rank < 0) throw new ValidationError('Rank must be non-negative');

        const currentRating = await this.get(input.uid);
        const maxDisplayRating = Math.max(
            currentRating?.maxDisplayRating || INITIAL_DISPLAY_RATING,
            clampRating(input.newDisplayRating),
        );

        await ratingColl.updateOne(
            { uid: input.uid },
            {
                $set: {
                    uid: input.uid,
                    internalRating: clampRating(input.newInternalRating),
                    displayRating: clampRating(input.newDisplayRating),
                    maxDisplayRating: clampRating(maxDisplayRating),
                    contestCount: Math.max(0, Math.floor(input.contestCount)),
                    lastUpdate: input.date || new Date(),
                },
            },
            { upsert: true },
        );

        await ratingHistoryColl.insertOne({
            _id: new ObjectId(),
            uid: input.uid,
            contestName: input.contestName.trim(),
            oldInternalRating: clampRating(input.oldInternalRating),
            newInternalRating: clampRating(input.newInternalRating),
            oldDisplayRating: clampRating(input.oldDisplayRating),
            newDisplayRating: clampRating(input.newDisplayRating),
            rank: input.rank,
            date: input.date || new Date(),
        });
    }

    static async getHistory(uid: number): Promise<RatingHistoryPublicView[]> {
        const history = await ratingHistoryColl.find({ uid }).sort({ date: 1 }).toArray();
        return history.map((record) => toPublicHistory(normalizeHistoryDoc(record)));
    }

    static async deleteRating(uid: number): Promise<void> {
        await Promise.all([
            ratingColl.deleteOne({ uid }),
            ratingHistoryColl.deleteMany({ uid }),
        ]);
    }

    static async getAllUsers(page = 1, limit = 50, search?: string): Promise<{ users: any[]; total: number }> {
        const skip = (page - 1) * limit;
        let query: any = {};

        if (search) {
            const userQuery = search.match(/^\d+$/)
                ? { _id: parseInt(search) }
                : {
                    $or: [
                        { uname: new RegExp(search, 'i') },
                        { mail: new RegExp(search, 'i') },
                    ],
                };
            const users = await UserModel.getMulti(userQuery).toArray();
            query = { uid: { $in: users.map((user) => user._id) } };
        }

        const [ratings, total] = await Promise.all([
            ratingColl.find(query).sort({ displayRating: -1 }).skip(skip).limit(limit).toArray(),
            ratingColl.countDocuments(query),
        ]);

        const uids = ratings.map((rating) => rating.uid);
        const users = await UserModel.getMulti({ _id: { $in: uids } }).toArray();
        const userMap = new Map(users.map((user) => [user._id, user]));

        return {
            users: ratings.map((raw) => {
                const rating = normalizeRatingDoc(raw);
                return {
                    uid: rating.uid,
                    ...toPublicRating(rating),
                    displayRating: rating.displayRating,
                    maxDisplayRating: rating.maxDisplayRating,
                    internalRating: rating.internalRating,
                    user: userMap.get(rating.uid),
                };
            }),
            total,
        };
    }

    static async initializeUserRating(uid: number, initialRating = INITIAL_DISPLAY_RATING): Promise<void> {
        await this.deleteRating(uid);
        await ratingColl.insertOne(createInitialRatingState(uid, initialRating));
    }

    static async initializeAllUsersRating(initialRating = INITIAL_DISPLAY_RATING): Promise<number> {
        const users = await UserModel.getMulti({}).toArray();
        for (const user of users) {
            await this.initializeUserRating(user._id, initialRating);
        }
        return users.length;
    }

    static async removeContestRating(uid: number, contestName: string, operatorUid?: number): Promise<boolean> {
        const record = await ratingHistoryColl.findOne({ uid, contestName });
        if (!record) return false;
        const historyRecord = normalizeHistoryDoc(record);
        const user = await UserModel.getById('system', uid);
        const username = user?.uname || `User${uid}`;

        await this.createArchive(
            contestName,
            'manual',
            [{
                uid,
                username,
                oldInternalRating: historyRecord.newInternalRating,
                newInternalRating: historyRecord.oldInternalRating,
                oldDisplayRating: historyRecord.newDisplayRating,
                newDisplayRating: historyRecord.oldDisplayRating,
                rank: historyRecord.rank,
                oldRank: historyRecord.rank,
                historyDate: historyRecord.date,
            }],
            operatorUid,
            `Manually removed contest record: ${contestName} for user ${username}`,
        );

        await ratingHistoryColl.deleteOne({ _id: historyRecord._id });
        await this.recalculateUserRating(uid);
        return true;
    }

    static async modifyContestRating(
        uid: number,
        contestName: string,
        newRating: number,
        newRank?: number,
        operatorUid?: number,
    ): Promise<boolean> {
        const rawRecord = await ratingHistoryColl.findOne({ uid, contestName });
        if (!rawRecord) return false;
        if (newRank !== undefined && newRank <= 0) {
            throw new ValidationError('Rank must be positive when modifying a contest record');
        }

        const historyRecord = normalizeHistoryDoc(rawRecord);
        const history = (await ratingHistoryColl.find({ uid }).sort({ date: 1 }).toArray())
            .map((record) => normalizeHistoryDoc(record));
        const targetIndex = history.findIndex((record) => String(record._id) === String(historyRecord._id));
        const contestCountAfter = history
            .slice(0, targetIndex + 1)
            .reduce((count, record) => count + (record.rank > 0 ? 1 : 0), 0);
        const newDisplayRating = clampRating(newRating);
        const newInternalRating = clampRating(newDisplayRating + getDisplayOffset(contestCountAfter));

        const user = await UserModel.getById('system', uid);
        const username = user?.uname || `User${uid}`;

        await this.createArchive(
            contestName,
            'manual',
            [{
                uid,
                username,
                oldInternalRating: historyRecord.newInternalRating,
                newInternalRating,
                oldDisplayRating: historyRecord.newDisplayRating,
                newDisplayRating,
                rank: newRank || historyRecord.rank,
                oldRank: historyRecord.rank,
                newRank: newRank || historyRecord.rank,
                historyDate: historyRecord.date,
            }],
            operatorUid,
            `Manually modified contest record: ${contestName} for user ${username} (${historyRecord.newDisplayRating} -> ${newDisplayRating})`,
        );

        const updateData: any = {
            newInternalRating,
            newDisplayRating,
        };
        if (newRank !== undefined) updateData.rank = newRank;

        await ratingHistoryColl.updateOne({ _id: historyRecord._id }, { $set: updateData });
        await this.recalculateUserRating(uid);
        return true;
    }

    static async recalculateUserRating(uid: number): Promise<void> {
        const history = (await ratingHistoryColl.find({ uid }).sort({ date: 1 }).toArray())
            .map((record) => normalizeHistoryDoc(record));

        if (history.length === 0) {
            const initialState = createInitialRatingState(uid);
            await ratingColl.updateOne(
                { uid },
                {
                    $set: {
                        uid,
                        internalRating: initialState.internalRating,
                        displayRating: initialState.displayRating,
                        maxDisplayRating: initialState.maxDisplayRating,
                        contestCount: 0,
                        lastUpdate: new Date(),
                    },
                },
                { upsert: true },
            );
            return;
        }

        let currentInternal = INITIAL_INTERNAL_RATING;
        let currentDisplay = INITIAL_DISPLAY_RATING;
        let contestCount = 0;
        let maxDisplayRating = INITIAL_DISPLAY_RATING;

        for (const record of history) {
            const isContest = record.rank > 0;
            const newContestCount = contestCount + (isContest ? 1 : 0);
            const newInternalRating = clampRating(record.newInternalRating);
            const newDisplayRating = calcDisplayRating(newInternalRating, newContestCount);

            await ratingHistoryColl.updateOne(
                { _id: record._id },
                {
                    $set: {
                        oldInternalRating: currentInternal,
                        oldDisplayRating: currentDisplay,
                        newInternalRating,
                        newDisplayRating,
                    },
                },
            );

            currentInternal = newInternalRating;
            currentDisplay = newDisplayRating;
            contestCount = newContestCount;
            maxDisplayRating = Math.max(maxDisplayRating, newDisplayRating);
        }

        await ratingColl.updateOne(
            { uid },
            {
                $set: {
                    uid,
                    internalRating: currentInternal,
                    displayRating: currentDisplay,
                    maxDisplayRating,
                    contestCount,
                    lastUpdate: new Date(),
                },
            },
            { upsert: true },
        );
    }

    static async processContestResults(
        contestName: string,
        participants: Array<{ uid: number; username: string; rank: number }>,
        operatorUid?: number,
    ): Promise<void> {
        const validParticipants = participants.filter((participant) => participant.rank > 0);
        if (!validParticipants.length) {
            throw new ValidationError('No valid participants found');
        }

        const pairwiseParticipants: PairwiseParticipant[] = [];
        for (const participant of validParticipants) {
            const rating = normalizeRatingDoc(await this.get(participant.uid), participant.uid);
            pairwiseParticipants.push({
                uid: participant.uid,
                username: participant.username,
                rank: participant.rank,
                oldInternalRating: rating.internalRating,
                oldDisplayRating: rating.displayRating,
                oldContestCount: rating.contestCount,
            });
        }

        const results = calculatePairwiseEloChanges(pairwiseParticipants);
        const archiveParticipants: RatingArchiveParticipant[] = [];

        for (const result of results) {
            archiveParticipants.push({
                uid: result.uid,
                username: result.username,
                oldInternalRating: result.oldInternalRating,
                newInternalRating: result.newInternalRating,
                oldDisplayRating: result.oldDisplayRating,
                newDisplayRating: result.newDisplayRating,
                rank: result.rank,
                newRank: result.rank,
            });

            await this.updateRating({
                uid: result.uid,
                contestName,
                rank: result.rank,
                oldInternalRating: result.oldInternalRating,
                newInternalRating: result.newInternalRating,
                oldDisplayRating: result.oldDisplayRating,
                newDisplayRating: result.newDisplayRating,
                contestCount: result.newContestCount,
            });
        }

        await this.createArchive(contestName, 'contest', archiveParticipants, operatorUid);
    }

    static async createArchive(
        contestName: string,
        operationType: 'contest' | 'manual',
        participants: RatingArchiveParticipant[],
        operatorUid?: number,
        description?: string,
    ): Promise<void> {
        await ratingArchiveColl.insertOne({
            _id: new ObjectId(),
            contestName,
            operationType,
            operationDate: new Date(),
            participants,
            operatorUid,
            description,
        });
    }

    static async getArchives(page = 1, limit = 20): Promise<{ archives: any[]; total: number }> {
        const total = await ratingArchiveColl.countDocuments();
        const archives = await ratingArchiveColl
            .find({})
            .sort({ operationDate: -1 })
            .skip((page - 1) * limit)
            .limit(limit)
            .toArray();
        return {
            archives: archives.map((archive) => toPublicArchive(archive)),
            total,
        };
    }

    static async revertLastOperation(): Promise<boolean> {
        const lastArchive = await ratingArchiveColl.findOne({}, { sort: { operationDate: -1 } });
        if (!lastArchive) return false;
        const description = String(lastArchive.description || '');

        for (const participant of lastArchive.participants || []) {
            const latestRecord = await ratingHistoryColl.findOne(
                { uid: participant.uid, contestName: lastArchive.contestName },
                { sort: { date: -1 } },
            );
            if (description.startsWith('Manually removed contest record:')) {
                await ratingHistoryColl.insertOne({
                    _id: new ObjectId(),
                    uid: participant.uid,
                    contestName: lastArchive.contestName,
                    oldInternalRating: clampRating(participant.newInternalRating),
                    newInternalRating: clampRating(participant.oldInternalRating),
                    oldDisplayRating: clampRating(participant.newDisplayRating),
                    newDisplayRating: clampRating(participant.oldDisplayRating),
                    rank: participant.oldRank ?? participant.rank ?? 0,
                    date: participant.historyDate ? new Date(participant.historyDate) : new Date(),
                });
            } else if (description.startsWith('Manually modified contest record:')) {
                if (latestRecord) {
                    await ratingHistoryColl.updateOne(
                        { _id: latestRecord._id },
                        {
                            $set: {
                                newInternalRating: clampRating(participant.oldInternalRating),
                                newDisplayRating: clampRating(participant.oldDisplayRating),
                                rank: participant.oldRank ?? participant.rank ?? 0,
                            },
                        },
                    );
                }
            } else if (latestRecord) {
                await ratingHistoryColl.deleteOne({ _id: latestRecord._id });
            }
            await this.recalculateUserRating(participant.uid);
        }

        await ratingArchiveColl.deleteOne({ _id: lastArchive._id });
        return true;
    }

    static async updateRatingByDelta(
        uid: number,
        delta: number,
        contestName: string,
        operatorUid?: number,
        increaseContestCount = false,
    ): Promise<void> {
        const current = normalizeRatingDoc(await this.get(uid), uid);
        const newInternalRating = clampRating(current.internalRating + delta);
        const newContestCount = current.contestCount + (increaseContestCount ? 1 : 0);
        const newDisplayRating = calcDisplayRating(newInternalRating, newContestCount);
        const user = await UserModel.getById('system', uid);
        const username = user?.uname || `User${uid}`;

        await this.createArchive(
            contestName,
            'manual',
            [{
                uid,
                username,
                oldInternalRating: current.internalRating,
                newInternalRating,
                oldDisplayRating: current.displayRating,
                newDisplayRating,
                rank: 0,
                oldRank: 0,
                newRank: 0,
            }],
            operatorUid,
            `Manual rating change: ${delta > 0 ? '+' : ''}${delta}${increaseContestCount ? ' (contestCount +1)' : ''}`,
        );

        await this.updateRating({
            uid,
            contestName,
            rank: 0,
            oldInternalRating: current.internalRating,
            newInternalRating,
            oldDisplayRating: current.displayRating,
            newDisplayRating,
            contestCount: newContestCount,
        });
    }
}

class RatingListHandler extends Handler {
    @query('page', Types.PositiveInt, true)
    async get(domainId: string, page = 1) {
        if (page < 1) throw new ValidationError('Page number must be positive');

        const limit = 50;
        const skip = (page - 1) * limit;
        const query = { contestCount: { $gt: 0 } };

        const [ratings, total] = await Promise.all([
            ratingColl.find(query).sort({ displayRating: -1 }).skip(skip).limit(limit).toArray(),
            ratingColl.countDocuments(query),
        ]);

        const users = await UserModel.getList(domainId, ratings.map((rating) => rating.uid));
        const leaderboard = ratings.map((raw, index) => {
            const rating = normalizeRatingDoc(raw);
            return {
                ...toPublicRating(rating),
                uid: rating.uid,
                rank: skip + index + 1,
                user: users[rating.uid],
            };
        });

        this.response.template = 'rating_list.html';
        this.response.body = {
            leaderboard,
            page,
            pages: Math.ceil(total / limit),
            total,
        };
    }
}

class UserRatingHandler extends Handler {
    @param('uid', Types.PositiveInt)
    async get(domainId: string, uid: number) {
        if (uid <= 0) throw new ValidationError('Invalid user ID');

        const user = await UserModel.getById(domainId, uid);
        if (!user) throw new NotFoundError('User not found');

        const [rating, history, rank] = await Promise.all([
            RatingModel.get(uid),
            RatingModel.getHistory(uid),
            RatingModel.getRank(uid),
        ]);

        this.response.template = 'user_rating.html';
        this.response.body = {
            udoc: user,
            rating: toPublicRating(rating),
            rank,
            history,
        };
    }
}

class RatingCenterHandler extends Handler {
    async prepare() {
        this.checkPriv(PRIV.PRIV_EDIT_SYSTEM);
    }

    @query('tab', Types.String, true)
    @query('page', Types.PositiveInt, true)
    @query('search', Types.String, true)
    async get(domainId: string, tab = 'manual', page = 1, search?: string) {
        const activeTab = normalizeRatingAdminTab(tab);
        const stats = await getRatingAdminStats();

        const body: Record<string, any> = {
            activeTab,
            stats,
            page_name: 'manage_rating_center',
            page: 1,
            pages: 1,
            total: 0,
            search: search || '',
            contestArchives: [],
            users: [],
            contestArchiveTotal: 0,
        };

        if (activeTab === 'contest') {
            const { archives, total } = await RatingModel.getArchives(1, 10);
            body.contestArchives = archives;
            body.contestArchiveTotal = total;
        } else if (activeTab === 'users') {
            const limit = 20;
            const { users, total } = await RatingModel.getAllUsers(page, limit, search);
            body.users = users;
            body.page = page;
            body.pages = Math.ceil(total / limit);
            body.total = total;
        }

        this.response.template = 'rating_center.html';
        this.response.body = body;
    }
}

class RatingManageHandler extends Handler {
    async prepare() {
        this.checkPriv(PRIV.PRIV_EDIT_SYSTEM);
    }

    async get() {
        this.response.redirect = this.url('manage_rating_center', { query: { tab: 'manual' } });
    }

    @param('uid', Types.PositiveInt)
    @param('ratingDelta', Types.Int)
    @param('contestName', Types.String)
    @param('increaseContestCount', Types.Boolean, true)
    async postUpdateRating(
        domainId: string,
        uid: number,
        ratingDelta: number,
        contestName: string,
        increaseContestCount?: boolean,
    ) {
        if (Math.abs(ratingDelta) > 1000) {
            throw new ValidationError('Rating change must be between -1000 and +1000');
        }
        if (!contestName.trim()) throw new ValidationError('Contest name cannot be empty');

        const user = await UserModel.getById(domainId, uid);
        if (!user) throw new NotFoundError('User not found');

        await RatingModel.updateRatingByDelta(
            uid,
            ratingDelta,
            contestName.trim(),
            this.user._id,
            !!increaseContestCount,
        );
        this.response.redirect = this.url('manage_rating_center', { query: { tab: 'manual' } });
    }
}

class ContestRatingComputeHandler extends Handler {
    async prepare() {
        this.checkPriv(PRIV.PRIV_EDIT_SYSTEM);
    }

    async get() {
        this.response.redirect = this.url('manage_rating_center', { query: { tab: 'contest' } });
    }

    @param('csvFile', Types.File, true)
    @param('csvContent', Types.String, true)
    @param('contestName', Types.String)
    async postImportContest(domainId: string, csvFile?: any, csvContent?: string, contestName?: string) {
        if (!contestName?.trim()) throw new ValidationError('Contest name cannot be empty');

        try {
            let csvData: string;
            const uploadedFile = csvFile || this.request.files?.csvFile;
            const bodyCsvContent: string | undefined = csvContent || this.request.body?.csvContent;

            if (uploadedFile) {
                if (typeof uploadedFile.read === 'function') {
                    csvData = (await uploadedFile.read()).toString('utf-8');
                } else if (uploadedFile.filepath) {
                    csvData = await readFile(uploadedFile.filepath, 'utf-8');
                } else {
                    throw new ValidationError('Invalid CSV file');
                }
            } else if (typeof bodyCsvContent === 'string' && bodyCsvContent.trim()) {
                csvData = bodyCsvContent;
            } else {
                throw new ValidationError('Either CSV file or CSV content must be provided');
            }

            const parseCSV = (csvText: string) => {
                const rows: string[][] = [];
                let currentRow: string[] = [];
                let currentField = '';
                let inQuotes = false;
                let i = 0;
                while (i < csvText.length) {
                    const char = csvText[i];
                    if (char === '"') {
                        if (inQuotes && csvText[i + 1] === '"') {
                            currentField += '"';
                            i += 2;
                            continue;
                        }
                        inQuotes = !inQuotes;
                    } else if (char === ',' && !inQuotes) {
                        currentRow.push(currentField.trim());
                        currentField = '';
                    } else if ((char === '\n' || char === '\r') && !inQuotes) {
                        currentRow.push(currentField.trim());
                        if (currentRow.some((field) => field !== '')) rows.push(currentRow);
                        currentRow = [];
                        currentField = '';
                        if (char === '\r' && csvText[i + 1] === '\n') i++;
                    } else if (char === '\n' && inQuotes) {
                        currentField += ' ';
                    } else if (!(char === '\r' && inQuotes)) {
                        currentField += char;
                    }
                    i++;
                }

                if (currentField !== '' || currentRow.length > 0) {
                    currentRow.push(currentField.trim());
                    if (currentRow.some((field) => field !== '')) rows.push(currentRow);
                }
                return rows;
            };

            const rows = parseCSV(csvData.trim());
            if (rows.length < 2) {
                throw new ValidationError('CSV file must contain at least header and one data row');
            }

            const header = rows[0];
            const rankIndex = header.findIndex((col) => col === '#' || col.includes('排名'));
            const usernameIndex = header.findIndex((col) => col === '用户' || col.includes('用户'));
            const problemColumns = header
                .map((col, index) => ({ col, index }))
                .filter(({ col }) => /^#\d+/.test(col) || col.includes('罚时'))
                .map(({ index }) => index);

            if (rankIndex === -1 || usernameIndex === -1) {
                throw new ValidationError('CSV must contain rank (#) and username (用户) columns');
            }

            const participants: Array<{ uid: number; username: string; rank: number }> = [];
            for (let i = 1; i < rows.length; i++) {
                const row = rows[i];
                const rank = parseInt(row[rankIndex]);
                const username = row[usernameIndex];
                if (!rank || rank === 0) continue;

                const hasSubmission = problemColumns.some((colIndex) => {
                    const value = row[colIndex];
                    return value && value.trim() !== '' && value.trim() !== '0' && value.trim() !== '0.0';
                });
                if (!hasSubmission) continue;

                const user = await UserModel.getByUname(domainId, username);
                if (!user) continue;
                participants.push({ uid: user._id, username, rank });
            }

            if (!participants.length) {
                throw new ValidationError('No valid participants with submissions found in CSV');
            }

            await RatingModel.processContestResults(contestName.trim(), participants, this.user._id);
            this.response.redirect = this.url('manage_rating_center', { query: { tab: 'contest' } });
        } catch (error) {
            if (error instanceof ValidationError) throw error;
            throw new ValidationError(`Failed to process CSV: ${error?.message ?? String(error)}`);
        }
    }

    async postRevertLast() {
        const success = await RatingModel.revertLastOperation();
        if (!success) throw new ValidationError('No operation to revert or revert failed');
        this.response.redirect = this.url('manage_rating_center', { query: { tab: 'contest' } });
    }
}

class RatingStatsHandler extends Handler {
    async get() {
        const [totalUsers, avgRating, maxRating] = await Promise.all([
            ratingColl.countDocuments({}),
            ratingColl.aggregate([{ $group: { _id: null, avgRating: { $avg: '$displayRating' } } }]).toArray(),
            ratingColl.findOne({}, { sort: { displayRating: -1 } }),
        ]);

        const activeUsers = await ratingColl.countDocuments({
            lastUpdate: { $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
        });

        this.response.body = {
            totalUsers,
            avgRating: avgRating[0]?.avgRating || 0,
            maxRating: maxRating?.displayRating || 0,
            activeUsers,
        };
    }
}

class RatingUserApiHandler extends Handler {
    @param('uid', Types.PositiveInt)
    async get(domainId: string, uid: number) {
        if (uid <= 0) throw new ValidationError('Invalid user ID');
        const [rating, history, rank] = await Promise.all([
            RatingModel.get(uid),
            RatingModel.getHistory(uid),
            RatingModel.getRank(uid),
        ]);
        this.response.body = {
            rating: toPublicRating(rating),
            history,
            rank,
        };
    }
}

class RatingTopHandler extends Handler {
    @query('limit', Types.PositiveInt, true)
    async get(domainId: string, limit = 10) {
        const normalizedLimit = Math.min(Math.max(limit, 1), 50);
        const ratings = await RatingModel.getLeaderboard(1, normalizedLimit);
        const users = ratings.length
            ? await UserModel.getList(domainId, ratings.map((rating) => rating.uid))
            : {};

        this.response.body = ratings.map((rating, index) => {
            const user = users[rating.uid];
            const uname = user?.uname || `User${rating.uid}`;
            return {
                uid: rating.uid,
                rank: index + 1,
                uname,
                displayName: user?.displayName || uname,
                rating: rating.displayRating,
                maxRating: rating.maxDisplayRating,
                contestCount: rating.contestCount,
            };
        });
    }
}

class UserInfoApiHandler extends Handler {
    @param('uid', Types.PositiveInt)
    async get(domainId: string, uid: number) {
        const user = await UserModel.getById(domainId, uid);
        if (!user) {
            this.response.body = { error: 'User not found' };
            return;
        }

        this.response.body = {
            uid,
            username: user.uname,
            displayName: user.displayName || user.uname,
        };
    }
}

class UserRatingManageHandler extends Handler {
    async prepare() {
        this.checkPriv(PRIV.PRIV_EDIT_SYSTEM);
    }

    @query('page', Types.PositiveInt, true)
    @query('search', Types.String, true)
    async get(domainId: string, page = 1, search?: string) {
        const query: Record<string, any> = { tab: 'users' };
        if (page > 1) query.page = page;
        if (search) query.search = search;
        this.response.redirect = this.url('manage_rating_center', { query });
    }

    @param('operation', Types.String)
    async post(domainId: string, operation: string) {
        if (operation === 'initialize_user') return this.postInitializeUser(domainId);
        if (operation === 'initialize_all') return this.postInitializeAll();
        if (operation === 'remove_contest') return this.postRemoveContest();
        if (operation === 'modify_contest') return this.postModifyContest();
        throw new ValidationError('Invalid operation');
    }

    async postInitializeUser(domainId: string) {
        const uid = parseInt(this.request.body.uid);
        const initialRating = parseInt(this.request.body.initialRating) || INITIAL_DISPLAY_RATING;
        const user = await UserModel.getById(domainId, uid);
        if (!user) throw new NotFoundError('User not found');
        await RatingModel.initializeUserRating(uid, initialRating);
        this.response.redirect = this.url('manage_rating_center', { query: { tab: 'users' } });
    }

    async postInitializeAll() {
        const initialRating = parseInt(this.request.body.initialRating) || INITIAL_DISPLAY_RATING;
        await RatingModel.initializeAllUsersRating(initialRating);
        this.response.redirect = this.url('manage_rating_center', { query: { tab: 'users' } });
    }

    async postRemoveContest() {
        const uid = parseInt(this.request.body.uid);
        const contestName = this.request.body.contestName;
        const success = await RatingModel.removeContestRating(uid, contestName, this.user._id);
        if (!success) throw new NotFoundError('Contest record not found');
        this.response.redirect = this.url('manage_rating_center', { query: { tab: 'users' } });
    }

    async postModifyContest() {
        const uid = parseInt(this.request.body.uid);
        const contestName = this.request.body.contestName;
        const newRating = parseInt(this.request.body.newRating);
        const newRank = this.request.body.newRank ? parseInt(this.request.body.newRank) : undefined;
        const success = await RatingModel.modifyContestRating(uid, contestName, newRating, newRank, this.user._id);
        if (!success) throw new NotFoundError('Contest record not found');
        this.response.redirect = this.url('manage_rating_center', { query: { tab: 'users' } });
    }
}

export async function apply(ctx: Context) {
    ctx.Route('manage_rating_center', '/manage/rating-center', RatingCenterHandler, PRIV.PRIV_EDIT_SYSTEM);
    ctx.Route('rating_list', '/rating', RatingListHandler, PERM.PERM_VIEW_RANKING);
    ctx.Route('user_rating', '/user/:uid/rating', UserRatingHandler);
    ctx.Route('rating_manage', '/manage/rating', RatingManageHandler, PRIV.PRIV_EDIT_SYSTEM);
    ctx.Route('user_rating_manage', '/manage/user-rating', UserRatingManageHandler, PRIV.PRIV_EDIT_SYSTEM);
    ctx.Route('contest_rating_compute', '/manage/rating/contest', ContestRatingComputeHandler, PRIV.PRIV_EDIT_SYSTEM);
    ctx.Route('rating_stats', '/api/rating/stats', RatingStatsHandler, PERM.PERM_VIEW_RANKING);
    ctx.Route('rating_top_api', '/api/rating/top', RatingTopHandler, PERM.PERM_VIEW_RANKING);
    ctx.Route('rating_user_api', '/api/rating/user/:uid', RatingUserApiHandler);
    ctx.Route('user_info_api', '/api/user/:uid/info', UserInfoApiHandler);

    ctx.injectUI('Nav', 'rating_list', { prefix: 'rating' });
    ctx.injectUI('ControlPanel', 'manage_rating_center', { icon: 'chart-line' });

    ctx.i18n.load('zh', {
        rating_center: 'Rating管理中心',
        rating_manage: 'Rating修改',
        contest_rating_compute: '比赛Rating计算',
        user_rating_manage: '用户Rating管理',
        rating_list: 'Rating排行榜',
        'Rating Leaderboard': 'Rating排行榜',
        'Rating Management': 'Rating管理',
        'Contest Rating Compute': '比赛Rating计算',
        'User Rating Management': '用户Rating管理',
    });

    ctx.i18n.load('en', {
        rating_manage: 'Rating Management',
        contest_rating_compute: 'Contest Rating Compute',
        user_rating_manage: 'User Rating Management',
        rating_list: 'Rating Leaderboard',
        'Rating Leaderboard': 'Rating Leaderboard',
        'Rating Management': 'Rating Management',
        'Contest Rating Compute': 'Contest Rating Compute',
        'User Rating Management': 'User Rating Management',
    });

    ctx.i18n.load('zh', {
        'Rating Management Center': 'Rating管理中心',
        Overview: '概览',
        'Manual Update': '手动修改',
        'Quick Actions': '快捷操作',
        'System Notes': '系统说明',
        'Recent Operations': '最近操作',
        'Rated Users': '已有Rating用户数',
        'Users With Contests': '有比赛记录用户数',
        'Manual rating updates do not increase contest count unless you explicitly check the option.': '手动修改Rating默认不会增加contestCount，除非你显式勾选对应选项。',
        'The leaderboard only includes users whose contest count is greater than zero.': '排行榜当前只显示contestCount大于0的用户。',
        'The homepage rating module only shows the top N users configured in homepage settings.': '首页Rating模块只显示首页设置中配置的前N名用户。',
        'Legacy manage routes now redirect into this center while keeping the original POST handlers.': '旧的管理路由现在会跳转到管理中心，同时仍保留原有POST处理逻辑。',
    });
    ctx.i18n.load('en', {
        rating_center: 'Rating Management Center',
        'Rating Management Center': 'Rating Management Center',
        Overview: 'Overview',
        'Manual Update': 'Manual Update',
        'Quick Actions': 'Quick Actions',
        'System Notes': 'System Notes',
        'Recent Operations': 'Recent Operations',
        'Rated Users': 'Rated Users',
        'Users With Contests': 'Users With Contests',
        'Manual rating updates do not increase contest count unless you explicitly check the option.': 'Manual rating updates do not increase contest count unless you explicitly check the option.',
        'The leaderboard only includes users whose contest count is greater than zero.': 'The leaderboard only includes users whose contest count is greater than zero.',
        'The homepage rating module only shows the top N users configured in homepage settings.': 'The homepage rating module only shows the top N users configured in homepage settings.',
        'Legacy manage routes now redirect into this center while keeping the original POST handlers.': 'Legacy manage routes now redirect into this center while keeping the original POST handlers.',
    });

    ctx.i18n.load('zh', {
        rating_center: 'Rating 管理中心',
        manage_rating_center: 'Rating 管理中心',
        rating_manage: 'Rating 修改',
        contest_rating_compute: '比赛 Rating 计算',
        user_rating_manage: '用户 Rating 管理',
        rating_list: 'Rating 排行榜',
        'Rating Leaderboard': 'Rating 排行榜',
        'Rating Management': 'Rating 管理',
        'Contest Rating Compute': '比赛 Rating 计算',
        'User Rating Management': '用户 Rating 管理',
        'Rating Management Center': 'Rating 管理中心',
        Overview: '概览',
        'Manual Update': '手动修改',
        'Quick Actions': '快捷操作',
        'System Notes': '系统说明',
        'Recent Operations': '最近操作',
        'Rated Users': '已有 Rating 用户数',
        'Users With Contests': '有比赛记录用户数',
        'Manual rating updates do not increase contest count unless you explicitly check the option.': '手动修改 Rating 默认不会增加 contestCount，除非你显式勾选对应选项。',
        'The leaderboard only includes users whose contest count is greater than zero.': '当前排行榜只显示 contestCount 大于 0 的用户。',
        'The homepage rating module only shows the top N users configured in homepage settings.': '首页 Rating 模块只显示首页设置中配置的前 N 名用户。',
        'Legacy manage routes now redirect into this center while keeping the original POST handlers.': '旧的管理路由现在会跳转到本管理中心，同时保留原有 POST 处理逻辑。',
        'Update User Rating': '修改用户 Rating',
        'User ID': '用户 ID',
        'Enter user ID': '请输入用户 ID',
        'Rating Change': 'Rating 变化值',
        'Enter rating change (e.g., +50, -50)': '请输入 Rating 变化值（如 +50、-50）',
        'Enter positive or negative value (e.g., +50 or -50)': '支持输入正数或负数，例如 +50 或 -50',
        'Contest Name': '比赛名称',
        'Enter contest name': '请输入比赛名称',
        'Increase contest count by 1': '参赛次数加 1',
        'Checked users can appear in the leaderboard if it requires at least one rated contest.': '勾选后，如果排行榜要求至少参加过一场计分比赛，该用户即可上榜。',
        'Update Rating': '更新 Rating',
        'Failed to load user info': '加载用户信息失败',
        'Import Contest Results': '导入比赛结果',
        'Upload contest ranking CSV file to preview and calculate rating changes using Pairwise Elo formula': '上传比赛排名 CSV 文件进行预览，并使用 Pairwise Elo 公式计算 Rating 变化。',
        'CSV File': 'CSV 文件',
        'Contest name will be auto-filled from filename': '比赛名称会根据文件名自动填充',
        'Preview CSV Data': '预览 CSV 数据',
        'CSV Preview': 'CSV 预览',
        'Valid Participants': '有效参赛者',
        'Filtered Out': '已过滤',
        Status: '状态',
        Note: '说明',
        'Confirm Import and Calculate Ratings': '确认导入并计算 Rating',
        Cancel: '取消',
        'Revert Operations': '回退操作',
        'Revert the most recent rating operation (contest import or manual update)': '回退最近一次 Rating 操作（比赛导入或手动修改）。',
        'Revert Last Operation': '回退最近一次操作',
        Participants: '参与人数',
        'Show Details': '查看详情',
        'Hide Details': '收起详情',
        'Old Rating': '旧 Rating',
        'New Rating': '新 Rating',
        Change: '变化值',
        'No operation history found.': '暂无操作记录。',
        'Error parsing CSV file': '解析 CSV 文件时出错',
        'Please select a CSV file and ensure contest name is filled': '请选择 CSV 文件并确保已填写比赛名称。',
        'CSV file must contain at least header and one data row': 'CSV 文件至少需要包含表头和一行数据。',
        'CSV must contain rank and username columns': 'CSV 必须包含排名和用户名两列。',
        'No submissions': '无提交记录',
        'Rank 0 (excluded)': '排名为 0（已排除）',
        'Will be included in rating calculation': '将参与 Rating 计算',
        Included: '已纳入',
        Excluded: '已排除',
        'Batch Operations': '批量操作',
        'Initialize All Users Rating': '初始化所有用户的 Rating',
        'Export User Data': '导出用户数据',
        'Search Users': '搜索用户',
        'Search by username, email, or user ID': '按用户名、邮箱或用户 ID 搜索',
        Search: '搜索',
        Clear: '清空',
        'User List': '用户列表',
        'Contest Count': '参赛次数',
        'Last Update': '最后更新时间',
        Actions: '操作',
        History: '历史',
        Initialize: '初始化',
        'Manage Contests': '管理比赛记录',
        Previous: '上一页',
        Next: '下一页',
        'No users found.': '未找到用户。',
        'Initialize User Rating': '初始化用户 Rating',
        'Warning:': '警告：',
        'This will reset all users\' ratings and delete their history records.': '这将重置所有用户的 Rating，并删除他们的历史记录。',
        'Are you sure? This cannot be undone.': '你确定吗？此操作无法撤销。',
        'Initialize All': '全部初始化',
        'This will reset the user\'s rating and delete their history records.': '这将重置该用户的 Rating，并删除其历史记录。',
        'User Contest History': '用户比赛历史',
        'Manage Contest Records': '管理比赛记录',
        'No contest history found.': '暂无比赛历史记录。',
        'Failed to load history data.': '加载历史数据失败。',
        'Click on a contest to modify or remove it:': '点击某场比赛可修改或删除其记录：',
        'No contest records found.': '暂无比赛记录。',
        'Failed to load contest data.': '加载比赛数据失败。',
        'Enter new rating for contest': '请输入该比赛的新 Rating',
        'Enter new rank for contest': '请输入该比赛的新排名',
        Modify: '修改',
        Remove: '删除',
        'Modify contest': '修改比赛',
        'rating to': '的 Rating 为',
        'Remove contest': '删除比赛',
        'from user\'s history?': '从该用户历史中移除吗？',
        'Export functionality will be implemented soon.': '导出功能即将支持。',
        'No rating data available yet.': '暂无 Rating 数据。',
        'Failed to load rating leaderboard.': '加载 Rating 排行榜失败。',
        'Manage rating updates, contest computations, and user maintenance from one place.': '在一个页面中统一处理 Rating 调整、比赛计算与用户维护。',
        'Adjust rating and contest count for a single user.': '为单个用户调整 Rating 与参赛次数。',
        'Import contest results, preview calculations, and revert recent operations.': '导入比赛结果、预览计算，并支持回退最近操作。',
        'Search users, inspect history, and manage contest records.': '搜索用户、查看历史，并管理比赛记录。',
        'CSV files must include # (rank) and username columns. Only users with submissions are included, and rank 0 entries are excluded.': 'CSV 需包含 #（排名）和 username（用户名）列；只有有提交记录的用户会参与 Rating 计算，排名为 0 的记录会被排除。',
        'Current Tab': '当前页面',
        'Quick Tips': '提示',
    });

    ctx.i18n.load('en', {
        rating_center: 'Rating Management Center',
        manage_rating_center: 'Rating Management Center',
        rating_manage: 'Rating Management',
        contest_rating_compute: 'Contest Rating Compute',
        user_rating_manage: 'User Rating Management',
        rating_list: 'Rating Leaderboard',
        'Rating Leaderboard': 'Rating Leaderboard',
        'Rating Management': 'Rating Management',
        'Contest Rating Compute': 'Contest Rating Compute',
        'User Rating Management': 'User Rating Management',
        'Rating Management Center': 'Rating Management Center',
        Overview: 'Overview',
        'Manual Update': 'Manual Update',
        'Quick Actions': 'Quick Actions',
        'System Notes': 'System Notes',
        'Recent Operations': 'Recent Operations',
        'Rated Users': 'Rated Users',
        'Users With Contests': 'Users With Contests',
        'Manual rating updates do not increase contest count unless you explicitly check the option.': 'Manual rating updates do not increase contest count unless you explicitly check the option.',
        'The leaderboard only includes users whose contest count is greater than zero.': 'The leaderboard only includes users whose contest count is greater than zero.',
        'The homepage rating module only shows the top N users configured in homepage settings.': 'The homepage rating module only shows the top N users configured in homepage settings.',
        'Legacy manage routes now redirect into this center while keeping the original POST handlers.': 'Legacy manage routes now redirect into this center while keeping the original POST handlers.',
        'Update User Rating': 'Update User Rating',
        'User ID': 'User ID',
        'Enter user ID': 'Enter user ID',
        'Rating Change': 'Rating Change',
        'Enter rating change (e.g., +50, -50)': 'Enter rating change (e.g., +50, -50)',
        'Enter positive or negative value (e.g., +50 or -50)': 'Enter positive or negative value (e.g., +50 or -50)',
        'Contest Name': 'Contest Name',
        'Enter contest name': 'Enter contest name',
        'Increase contest count by 1': 'Increase contest count by 1',
        'Checked users can appear in the leaderboard if it requires at least one rated contest.': 'Checked users can appear in the leaderboard if it requires at least one rated contest.',
        'Update Rating': 'Update Rating',
        'Failed to load user info': 'Failed to load user info',
        'Import Contest Results': 'Import Contest Results',
        'Upload contest ranking CSV file to preview and calculate rating changes using Pairwise Elo formula': 'Upload contest ranking CSV file to preview and calculate rating changes using Pairwise Elo formula',
        'CSV File': 'CSV File',
        'Contest name will be auto-filled from filename': 'Contest name will be auto-filled from filename',
        'Preview CSV Data': 'Preview CSV Data',
        'CSV Preview': 'CSV Preview',
        'Valid Participants': 'Valid Participants',
        'Filtered Out': 'Filtered Out',
        Status: 'Status',
        Note: 'Note',
        'Confirm Import and Calculate Ratings': 'Confirm Import and Calculate Ratings',
        Cancel: 'Cancel',
        'Revert Operations': 'Revert Operations',
        'Revert the most recent rating operation (contest import or manual update)': 'Revert the most recent rating operation (contest import or manual update)',
        'Revert Last Operation': 'Revert Last Operation',
        Participants: 'Participants',
        'Show Details': 'Show Details',
        'Hide Details': 'Hide Details',
        'Old Rating': 'Old Rating',
        'New Rating': 'New Rating',
        Change: 'Change',
        'No operation history found.': 'No operation history found.',
        'Error parsing CSV file': 'Error parsing CSV file',
        'Please select a CSV file and ensure contest name is filled': 'Please select a CSV file and ensure contest name is filled',
        'CSV file must contain at least header and one data row': 'CSV file must contain at least header and one data row',
        'CSV must contain rank and username columns': 'CSV must contain rank and username columns',
        'No submissions': 'No submissions',
        'Rank 0 (excluded)': 'Rank 0 (excluded)',
        'Will be included in rating calculation': 'Will be included in rating calculation',
        Included: 'Included',
        Excluded: 'Excluded',
        'Batch Operations': 'Batch Operations',
        'Initialize All Users Rating': 'Initialize All Users Rating',
        'Export User Data': 'Export User Data',
        'Search Users': 'Search Users',
        'Search by username, email, or user ID': 'Search by username, email, or user ID',
        Search: 'Search',
        Clear: 'Clear',
        'User List': 'User List',
        'Contest Count': 'Contest Count',
        'Last Update': 'Last Update',
        Actions: 'Actions',
        History: 'History',
        Initialize: 'Initialize',
        'Manage Contests': 'Manage Contests',
        Previous: 'Previous',
        Next: 'Next',
        'No users found.': 'No users found.',
        'Initialize User Rating': 'Initialize User Rating',
        'Warning:': 'Warning:',
        'This will reset all users\' ratings and delete their history records.': 'This will reset all users\' ratings and delete their history records.',
        'Are you sure? This cannot be undone.': 'Are you sure? This cannot be undone.',
        'Initialize All': 'Initialize All',
        'This will reset the user\'s rating and delete their history records.': 'This will reset the user\'s rating and delete their history records.',
        'User Contest History': 'User Contest History',
        'Manage Contest Records': 'Manage Contest Records',
        'No contest history found.': 'No contest history found.',
        'Failed to load history data.': 'Failed to load history data.',
        'Click on a contest to modify or remove it:': 'Click on a contest to modify or remove it:',
        'No contest records found.': 'No contest records found.',
        'Failed to load contest data.': 'Failed to load contest data.',
        'Enter new rating for contest': 'Enter new rating for contest',
        'Enter new rank for contest': 'Enter new rank for contest',
        Modify: 'Modify',
        Remove: 'Remove',
        'Modify contest': 'Modify contest',
        'rating to': 'rating to',
        'Remove contest': 'Remove contest',
        'from user\'s history?': 'from user\'s history?',
        'Export functionality will be implemented soon.': 'Export functionality will be implemented soon.',
        'No rating data available yet.': 'No rating data available yet.',
        'Failed to load rating leaderboard.': 'Failed to load rating leaderboard.',
        'Manage rating updates, contest computations, and user maintenance from one place.': 'Manage rating updates, contest computations, and user maintenance from one place.',
        'Adjust rating and contest count for a single user.': 'Adjust rating and contest count for a single user.',
        'Import contest results, preview calculations, and revert recent operations.': 'Import contest results, preview calculations, and revert recent operations.',
        'Search users, inspect history, and manage contest records.': 'Search users, inspect history, and manage contest records.',
        'CSV files must include # (rank) and username columns. Only users with submissions are included, and rank 0 entries are excluded.': 'CSV files must include # (rank) and username columns. Only users with submissions are included, and rank 0 entries are excluded.',
        'Current Tab': 'Current Tab',
        'Quick Tips': 'Quick Tips',
    });

    ctx.on('contest/finish', async (domainId, tid) => {
        console.log(`Contest ${tid} finished, rating auto-update hook is available for domain ${domainId}.`);
    });
}

global.Hydro.model.rating = RatingModel;
