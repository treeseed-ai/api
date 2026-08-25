import type { ControlPlaneStore } from '../../persistence/store.ts';
import {
	completeKnowledgePublicationMethod, createKnowledgePublicationMethod, createKnowledgeReviewMethod, createKnowledgeWorkspaceRecordMethod,
	getKnowledgeReviewByWorkspaceMethod, submitKnowledgeWorkspaceMethod,
	decideKnowledgeReviewMethod, getKnowledgePublicationByReviewMethod, getKnowledgeReviewMethod, getKnowledgeWorkspaceMethod,
	updateKnowledgePublicationMethod, updateKnowledgeWorkspaceMethod,
	listKnowledgeReviewsMethod,
	recordKnowledgeEditorialReviewMethod,
} from '../knowledge/collaboration.ts';
import {
	createBookCollectionMethod, createKnowledgePackBuildMethod, deleteBookCollectionMethod,
	getBookCollectionMethod, getKnowledgePackBuildMethod, listBookCollectionsMethod,
	listKnowledgePackBuildsMethod, updateBookCollectionMethod, updateKnowledgePackBuildMethod,
} from '../knowledge/packs.ts';
import { createKnowledgeReviewCommentMethod, heartbeatKnowledgeWorkspaceMethod, listKnowledgeReviewCommentsMethod,
	listKnowledgeWorkspacePresenceMethod, resolveKnowledgeReviewCommentMethod } from '../knowledge/review-collaboration.ts';

export function installKnowledgeStoreMethods(prototype: ControlPlaneStore) {
	prototype.createKnowledgeWorkspaceRecord = createKnowledgeWorkspaceRecordMethod;
	prototype.getKnowledgeWorkspace = getKnowledgeWorkspaceMethod;
	prototype.updateKnowledgeWorkspace = updateKnowledgeWorkspaceMethod;
	prototype.createKnowledgeReview = createKnowledgeReviewMethod;
	prototype.getKnowledgeReviewByWorkspace = getKnowledgeReviewByWorkspaceMethod;
	prototype.submitKnowledgeWorkspace = submitKnowledgeWorkspaceMethod;
	prototype.getKnowledgeReview = getKnowledgeReviewMethod;
	prototype.listKnowledgeReviews = listKnowledgeReviewsMethod;
	prototype.decideKnowledgeReview = decideKnowledgeReviewMethod;
	prototype.recordKnowledgeEditorialReview = recordKnowledgeEditorialReviewMethod;
	prototype.createKnowledgePublication = createKnowledgePublicationMethod;
	prototype.getKnowledgePublicationByReview = getKnowledgePublicationByReviewMethod;
	prototype.updateKnowledgePublication = updateKnowledgePublicationMethod;
	prototype.completeKnowledgePublication = completeKnowledgePublicationMethod;
	prototype.listBookCollections = listBookCollectionsMethod;
	prototype.getBookCollection = getBookCollectionMethod;
	prototype.createBookCollection = createBookCollectionMethod;
	prototype.updateBookCollection = updateBookCollectionMethod;
	prototype.deleteBookCollection = deleteBookCollectionMethod;
	prototype.createKnowledgePackBuild = createKnowledgePackBuildMethod;
	prototype.getKnowledgePackBuild = getKnowledgePackBuildMethod;
	prototype.listKnowledgePackBuilds = listKnowledgePackBuildsMethod;
	prototype.updateKnowledgePackBuild = updateKnowledgePackBuildMethod;
	prototype.heartbeatKnowledgeWorkspace = heartbeatKnowledgeWorkspaceMethod;
	prototype.listKnowledgeWorkspacePresence = listKnowledgeWorkspacePresenceMethod;
	prototype.createKnowledgeReviewComment = createKnowledgeReviewCommentMethod;
	prototype.listKnowledgeReviewComments = listKnowledgeReviewCommentsMethod;
	prototype.resolveKnowledgeReviewComment = resolveKnowledgeReviewCommentMethod;
}
